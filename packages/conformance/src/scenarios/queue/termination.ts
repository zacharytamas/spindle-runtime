import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { attempt, gate, ok, quiet, type Scenario, shape, toolResults, using, waitForAdmission } from "../harness.ts"

import { echo } from "./fixtures.ts"

export const Q13: Scenario = {
  name: "Q13 aborts a running thread that another session terminates, marks it, and refuses every later admission",
  requirements: ["b4305106", "e95fd065", "dc7d7df0", "d0a36934", "54d362c5", "9090af10", "f0250a42", "7b26e7c9"],
  run: async (driver) => {
    const held = gate()
    let signal: AbortSignal | undefined
    const watch = defineTool({
      description: "Wait for the abort",
      execute: async (state: ThreadState) => {
        signal = state.execution?.abortSignal
        held.release()
        await new Promise((resolve) => signal?.addEventListener("abort", resolve))
        return ok("aborted")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_watch", name: "watch", arguments: {} }] }])
    await using(driver, { provider, tools: { watch, echo } }, async (session, thread) => {
      const run = session.send(thread, "go")
      await held.opened
      const peer = await session.peer()
      try {
        const before = await peer.state(thread)
        await before.queueMessage({ role: "user", content: "pending" })
        expect(await before.terminate()).toBeUndefined()
        expect(await run).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
        expect(signal?.aborted).toBe(true)
        const after = await peer.state(thread)
        expect(after.terminated).toEqual(expect.any(Number))
        expect(String(after.terminated)).toHaveLength(16)
        expect(await after.status()).toMatchObject({ state: "idle", reason: "aborted" })
        expect((await session.messages(thread)).map((m) => [m.role, m.tool_status ?? m.content])).toEqual([
          ["user", "go"],
          ["assistant", null],
          ["tool", "error"],
        ])
        const refusal = `thread ${thread} is terminated, so it takes no new message, queued work, or execution`
        for (const state of [before, after, await session.state(thread)]) {
          await expect(state.queueMessage({ role: "user", content: "late" })).rejects.toThrow(refusal)
          expect(() => state.queueTool("echo", { text: "late" })).toThrow(refusal)
        }
        await expect(peer.send(thread, "late")).rejects.toThrow(refusal)
        await expect(session.send(thread, "late")).rejects.toThrow(refusal)
        expect(provider.requests).toHaveLength(1)
        expect(await session.messages(thread)).toHaveLength(3)
      } finally {
        await peer.close()
      }
    })
  },
}

export const Q14: Scenario = {
  name: "Q14 terminates a thread at rest without a run, keeps its history readable, and refuses every later admission",
  requirements: ["b4305106", "dc7d7df0", "d0a36934", "9090af10", "f0250a42", "7b26e7c9", "b83b63ca"],
  run: async (driver) => {
    const provider = new ScriptedProvider([{ text: "first reply" }])
    await using(driver, { provider, tools: { echo } }, async (session, thread) => {
      const fresh = await session.createThread("assistant")
      expect(await session.send(thread, "first")).toMatchObject({ status: "idle" })
      const handles = [await session.state(thread), await session.state(fresh)]
      const settled = await handles[0]?.status()
      for (const handle of handles) expect(await handle.terminate()).toBeUndefined()
      const peer = await session.peer()
      try {
        const reopened = await peer.state(thread)
        const marker = reopened.terminated
        expect(marker).toEqual(expect.any(Number))
        await reopened.terminate()
        expect((await peer.state(thread)).terminated).toBe(marker)
        expect(await reopened.status()).toEqual(settled)
        expect(await (await peer.state(fresh)).status()).toEqual({ state: "idle", since: 0, reason: null })
        expect((await reopened.getMessages({ order: "asc" })).messages.map((m) => m.content)).toEqual([
          "first",
          "first reply",
        ])
        for (const [id, state] of [
          [thread, reopened],
          [fresh, await peer.state(fresh)],
          [thread, handles[0]],
        ] as const) {
          const refusal = `thread ${id} is terminated, so it takes no new message, queued work, or execution`
          await expect(state?.queueMessage({ role: "user", content: "late" })).rejects.toThrow(refusal)
          expect(() => state?.queueTool("echo", { text: "late" })).toThrow(refusal)
          await expect(peer.send(id, "late")).rejects.toThrow(refusal)
        }
        expect(provider.requests).toHaveLength(1)
      } finally {
        await peer.close()
      }
    })
  },
}

export const Q16: Scenario = {
  name: "Q16 ends a write that a tool's injectMessage started when terminate aborts the run, and refuses the tool's later calls",
  requirements: ["e95fd065"],
  run: async (driver) => {
    const inHook = gate()
    const releaseHook = gate()
    const toolStarted = gate()
    let toolState: ThreadState | undefined
    let injection: Promise<unknown> | undefined
    const slow = defineHook({
      hook: "before_create_message",
      id: "slow",
      execute: async (_state, message) => {
        if (message.content === "from the tool") {
          inHook.release()
          await releaseHook.opened
        }
        return message
      },
    })
    const inject = defineTool({
      description: "Inject a message and wait",
      execute: async (state: ThreadState) => {
        toolState = state
        injection = state.injectMessage({ role: "user", content: "from the tool" }).then(
          () => "stored",
          (error: Error) => `rejected: ${error.message}`,
        )
        toolStarted.release()
        await new Promise(() => {})
        return ok("never")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_inject", name: "inject", arguments: {} }] }])
    await using(
      driver,
      { provider, tools: { inject }, hooks: [slow], prompt: { hooks: ["slow"] } },
      async (session, thread) => {
        const run = session.send(thread, "go")
        await Promise.all([toolStarted.opened, inHook.opened])
        await (await session.state(thread)).terminate()
        expect(await run).toMatchObject({ status: "idle", reason: "aborted" })
        releaseHook.release()
        expect(await injection).toMatch(/^rejected: /)
        await expect(toolState?.getValue("anything")).rejects.toThrow(/has ended, so Spindle refused this call/)
        expect((await session.messages(thread)).map((m) => m.content)).not.toContain("from the tool")
      },
    )
  },
}

export const Q34: Scenario = {
  name: "Q34 fails a send that waited behind a run with ThreadTerminated when another session terminates the thread",
  requirements: ["dc7d7df0", "9090af10"],
  run: async (driver) => {
    const held = gate()
    const watch = defineTool({
      description: "Wait for the abort",
      execute: async (state: ThreadState) => {
        const signal = state.execution?.abortSignal
        held.release()
        await new Promise((resolve) => signal?.addEventListener("abort", resolve))
        return ok("aborted")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_watch", name: "watch", arguments: {} }] }])
    await using(driver, { provider, tools: { watch } }, async (session, thread) => {
      const waiter = await session.peer()
      const other = await session.peer()
      try {
        const run = quiet(session.send(thread, "go"))
        await held.opened
        const behindHere = attempt(() => session.send(thread, "waited here"))
        const behindElsewhere = attempt(() => waiter.send(thread, "waited elsewhere"))
        // Both sends are durable once their entries are in the queue. The poll only waits for those two writes.
        await waitForAdmission(async () => (await other.inspect(thread)).queue.length >= 2)
        await (await other.state(thread)).terminate()
        expect(await run).toMatchObject({ status: "idle", reason: "aborted" })
        expect({ behindHere: await behindHere, behindElsewhere: await behindElsewhere }).toEqual({
          behindHere: "ThreadTerminated",
          behindElsewhere: "ThreadTerminated",
        })
        expect(shape(await session.messages(thread)).map((row) => row[0])).toEqual(["user", "assistant", "tool"])
        expect(provider.requests).toHaveLength(1)
      } finally {
        await waiter.close()
        await other.close()
      }
    })
  },
}

export const Q35: Scenario = {
  name: "Q35 never reports idle to a sender whose run could not be settled",
  requirements: ["37e4432c"],
  run: async (driver) => {
    const provider = new ScriptedProvider([{ text: "a reply" }])
    await using(driver, { provider }, async (session, thread) => {
      await session.breakSettlement(thread)
      const reported = await session.send(thread, "go").then(
        (outcome) => outcome.status,
        () => "rejected",
      )
      const stored = await session.inspect(thread)
      expect([stored.status.state, reported === "idle" ? "idle" : "a failure"]).toEqual(["running", "a failure"])
    })
  },
}

export const Q36: Scenario = {
  name: "Q36 shows the termination time on the handle whose terminate() resolved",
  requirements: ["7b26e7c9"],
  run: async (driver) => {
    const provider = new ScriptedProvider([])
    await using(driver, { provider }, async (session, thread) => {
      const state = await session.state(thread)
      expect(state.terminated).toBeNull()
      await state.terminate()
      const fresh = (await session.state(thread)).terminated
      expect(fresh).toEqual(expect.any(Number))
      expect(state.terminated).toBe(fresh)
    })
  },
}

export const Q39: Scenario = {
  name: "Q39 closes both unanswered calls with the same error about whether the tool ran and never enters the second tool",
  requirements: ["286367b3"],
  run: async (driver) => {
    const entered = gate()
    const leave = gate()
    const ran: Array<string> = []
    const hold = defineTool({
      description: "Wait for the test",
      execute: async () => {
        ran.push("hold")
        entered.release()
        await leave.opened
        return ok("returned")
      },
    })
    const later = defineTool({
      description: "Record the run",
      execute: async () => {
        ran.push("later")
        return ok("ran")
      },
    })
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c_hold", name: "hold", arguments: {} },
          { id: "c_later", name: "later", arguments: {} },
        ],
      },
    ])
    await using(
      driver,
      { provider, tools: { hold, later } },
      async (session, thread) => {
        const peer = await session.peer()
        try {
          const run = quiet(session.send(thread, "go")).catch(() => undefined)
          await entered.opened
          try {
            await peer.forceRecover(thread)
          } finally {
            leave.release()
          }
          await run
          const results = toolResults(await peer.messages(thread))
          expect(results.map((m) => [m.tool_call_id, m.tool_status])).toEqual([
            ["c_hold", "error"],
            ["c_later", "error"],
          ])
          for (const result of results) {
            expect(result.content).toBe(
              "Spindle lost the execution before it stored a result for this call. It does not know whether the tool ran, and it did not run the tool again.",
            )
            expect(result.content).not.toContain("whether the tool finished")
          }
          expect(ran).toEqual(["hold"])
        } finally {
          await peer.close()
        }
      },
      {},
    )
  },
}
