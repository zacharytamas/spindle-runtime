import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { attempt, gate, ok, quiet, type Scenario, statusOf, usingPeer, waitForAdmission } from "../harness.ts"

import { all, contents } from "./fixtures.ts"

const YEAR_MS = 365 * 24 * 60 * 60 * 1000

// Runs the body with the wall clock of this process moved by the shift. Timers keep their own time.
const withClockShift = async <A>(shiftMs: number, body: () => Promise<A>): Promise<A> => {
  const real = Date.now
  Date.now = () => real() + shiftMs
  try {
    return await body()
  } finally {
    Date.now = real
  }
}

export const O05: Scenario = {
  name: "O05 keeps a thread running whose holder is alive, however far the observer's wall clock moves",
  requirements: ["286367b3"],
  run: async (driver) => {
    const held = gate()
    const release = gate()
    const provider = new ScriptedProvider([
      async () => {
        held.release()
        await release.opened
        return { text: "the real reply" }
      },
    ])
    await usingPeer(
      driver,
      { provider },
      async (session, thread, peer) => {
        const run = quiet(session.send(thread, "go"))
        await held.opened
        const observer = await peer.state(thread)
        const seen: Array<string> = []
        try {
          for (const shift of [YEAR_MS, -YEAR_MS])
            seen.push(await withClockShift(shift, async () => (await observer.status()).state))
          seen.push((await observer.status()).state)
        } finally {
          release.release()
        }
        expect(seen).toEqual(["running", "running", "running"])
        expect(await run).toMatchObject({ status: "idle", reason: "stop_on_response" })
        expect(await contents(session, thread)).toEqual(["go", "the real reply"])
      },
      {},
    )
  },
}

export const O06: Scenario = {
  name: "O06 holds the thread after an abort until a tool that ignores the signal returns, then delivers the send that waited",
  requirements: ["0953e887", "e28dedf2"],
  run: async (driver) => {
    const entered = gate()
    const aborted = gate()
    const leave = gate()
    const order: Array<string> = []
    let lateWrite: Promise<string> | undefined
    const stubborn = defineTool({
      description: "Wait for the test and ignore the abort",
      execute: async (state: ThreadState) => {
        order.push("tool starts")
        state.execution?.abortSignal.addEventListener("abort", () => {
          lateWrite = attempt(() => state.setValue("after-abort", "yes"))
          aborted.release()
        })
        entered.release()
        await leave.opened
        order.push("tool returns")
        return ok("returned after the abort")
      },
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_stubborn", name: "stubborn", arguments: {} }] },
      () => {
        order.push("second model call")
        return { text: "the reply to B" }
      },
    ])
    await usingPeer(driver, { provider, tools: { stubborn } }, async (session, thread, peer) => {
      const first = quiet(session.send(thread, "A")).catch(() => undefined)
      await entered.opened
      expect(await session.abort(thread)).toBe(true)
      await aborted.opened
      const whileToolRuns = (await statusOf(peer, thread)).state
      const second = quiet(session.send(thread, "B"))
      // The send is durable once its entry is in the queue or in the history. The poll only waits for that write.
      await waitForAdmission(async () => {
        const stored = await peer.inspect(thread)
        return stored.queue.length > 0 || stored.messages.some((message) => message.content === "B")
      })
      const beforeReturn = (await statusOf(peer, thread)).state
      leave.release()
      const outcome = await second
      await first
      expect({ whileToolRuns, beforeReturn, order, outcome: [outcome.status, outcome.reason] }).toEqual({
        whileToolRuns: "running",
        beforeReturn: "running",
        order: ["tool starts", "tool returns", "second model call"],
        outcome: ["idle", "stop_on_response"],
      })
      expect(await lateWrite).toMatch(/^(ExecutionEnded|HandleExpired|FlowEnded)$/)
      expect(await contents(session, thread)).toEqual(["A", null, "error", "B", "the reply to B"])
      expect((await peer.inspect(thread)).values).toEqual({})
      expect(provider.requests).toHaveLength(2)
    })
  },
}

export const O07: Scenario = {
  name: "O07 settles a terminated thread immediately and refuses the unfinished tool’s writes",
  requirements: ["e95fd065", "0953e887"],
  run: async (driver) => {
    const entered = gate()
    const leave = gate()
    const late = gate()
    let refused = ""
    const stubborn = defineTool({
      description: "Wait for the test and ignore the abort",
      execute: async (state: ThreadState) => {
        entered.release()
        await leave.opened
        refused = await attempt(() => state.setValue("late", "write"))
        late.release()
        return ok("returned after the terminate")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_stubborn", name: "stubborn", arguments: {} }] }])
    await usingPeer(driver, { provider, tools: { stubborn } }, async (session, thread, peer) => {
      const run = quiet(session.send(thread, "A"))
      await entered.opened
      expect(await (await session.state(thread)).terminate()).toBeUndefined()
      const during = await peer.inspect(thread)
      expect(await attempt(() => peer.send(thread, "B"))).toBe("ThreadTerminated")
      leave.release()
      await late.opened
      expect(refused).toMatch(/^(ExecutionEnded|FlowEnded|HandleExpired)$/)
      expect(provider.requests).toHaveLength(1)
      const outcome = await run
      const after = await peer.inspect(thread)
      expect({
        during: [during.status.state, during.status.reason, during.terminated === null],
        outcome: [outcome.status, outcome.reason],
        after: [after.status.state, after.status.reason, after.terminated === during.terminated, after.claim],
      }).toEqual({
        during: ["idle", "aborted", false],
        outcome: ["idle", "aborted"],
        after: ["idle", "aborted", true, null],
      })
      expect(await contents(session, thread)).toEqual(["A", null, "error"])
    })
  },
}

export const O19: Scenario = {
  name: "O19 refuses an update, a delete, and a key-value write from outside on a terminated thread, and any write of an older handle",
  requirements: ["dc7d7df0", "9090af10"],
  run: async (driver) => {
    const provider = new ScriptedProvider([{ text: "first reply" }])
    await usingPeer(driver, { provider }, async (session, thread, peer) => {
      expect(await session.send(thread, "first")).toMatchObject({ status: "idle" })
      const older = await session.state(thread)
      await older.setValue("kept", "before")
      const target = (await session.messages(thread))[0]?.id ?? ""
      await (await peer.state(thread)).terminate()
      const before = await peer.inspect(thread)
      const fresh = await peer.state(thread)
      const outcomes = {
        freshUpdate: await attempt(() => fresh.updateMessage(target, { content: "edited after the end" })),
        freshDelete: await attempt(() => fresh.deleteMessage(target)),
        freshSetValue: await attempt(() => fresh.setValue("late", "yes")),
        freshDeleteValue: await attempt(() => fresh.setValue("kept", null)),
        olderInject: await attempt(() => older.injectMessage({ role: "user", content: "from the older handle" })),
        olderSetValue: await attempt(() => older.setValue("late", "yes")),
      }
      expect(outcomes).toEqual(all(Object.keys(outcomes), "ThreadTerminated"))
      expect(await peer.inspect(thread)).toEqual(before)
    })
  },
}

export const O20: Scenario = {
  name: "O20 stores a message that a new handle injects into a terminated thread, and lets it read the thread",
  requirements: [],
  run: async (driver) => {
    const provider = new ScriptedProvider([{ text: "first reply" }])
    await usingPeer(driver, { provider }, async (session, thread, peer) => {
      expect(await session.send(thread, "first")).toMatchObject({ status: "idle" })
      await (await session.state(thread)).setValue("kept", "before")
      await (await session.state(thread)).terminate()
      const fresh = await peer.state(thread)
      expect(await attempt(() => fresh.injectMessage({ role: "user", content: "a note" }))).toBe("done")
      expect(await fresh.getValue("kept")).toBe("before")
      expect((await fresh.getMessages({ order: "asc" })).messages.map((m) => m.content)).toEqual([
        "first",
        "first reply",
        "a note",
      ])
      expect(provider.requests).toHaveLength(1)
    })
  },
}

export const O21 = (["send", "queueMessage"] as const).map(
  (method): Scenario => ({
    name: `O21 settles a same-turn abort after ${method} on an idle thread`,
    requirements: [],
    run: async (driver) => {
      const provider = new ScriptedProvider([{ text: "reply" }, { text: "second reply" }])
      await usingPeer(driver, { provider }, async (session, thread, peer) => {
        const state = await session.state(thread)
        const first = method === "send" ? quiet(session.send(thread, "A")) : undefined
        if (!first) await state.queueMessage({ role: "user", content: "A" })
        expect(await session.abort(thread)).toBe(true)
        if (first) expect(await first).toMatchObject({ status: "idle", reason: "aborted_by_user" })
        await session.settled(thread)
        expect(await session.send(thread, "B")).toMatchObject({ status: "idle" })
        expect(await peer.inspect(thread)).toMatchObject({ claim: null, status: { state: "idle" } })
        expect((await contents(peer, thread)).filter((value) => value === "A" || value === "B")).toEqual(["A", "B"])
      })
    },
  }),
)

export const O22: Scenario = {
  name: "O22 abort releases a thread after an earlier hook timed out",
  requirements: [],
  run: async (driver) => {
    const entered = gate()
    const release = gate()
    const hang = defineHook({
      hook: "after_create_message",
      id: "hang",
      execute: async (_state, message) => {
        if (message.content === "A") await new Promise<void>(() => {})
      },
    })
    const provider = new ScriptedProvider([
      async () => {
        entered.release()
        await release.opened
        return { text: "unused" }
      },
      { text: "reply" },
    ])
    await usingPeer(
      driver,
      { provider, hooks: [hang], agent: { hooks: ["hang"] } },
      async (session, thread, peer) => {
        const first = quiet(session.send(thread, "A"))
        await entered.opened
        expect(await session.abort(thread)).toBe(true)
        release.release()
        expect(await first).toMatchObject({ status: "idle", reason: "aborted_by_user" })
        expect(await peer.inspect(thread)).toMatchObject({ claim: null })
        expect(await session.send(thread, "B")).toMatchObject({ status: "idle" })
      },
      { hookTimeoutMs: 50 },
    )
  },
}

export const O23: Scenario = {
  name: "O23 repeated termination from old and new handles keeps the first timestamp and history",
  requirements: [],
  run: async (driver) =>
    usingPeer(driver, { provider: new ScriptedProvider([]) }, async (session, thread, peer) => {
      const older = await peer.state(thread)
      const first = await session.state(thread)
      await first.terminate()
      const before = await peer.inspect(thread)
      for (const handle of [older, first, await session.state(thread)]) {
        await handle.terminate()
        expect(await peer.inspect(thread)).toEqual(before)
      }
    }),
}
