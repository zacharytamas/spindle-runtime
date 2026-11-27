import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { attempt, gate, ok, quiet, type Scenario, usingPeer } from "../harness.ts"

import { all, contents, noop } from "./fixtures.ts"

// The writes that item 1 of the M1-6 fix round names, as one ThreadState makes them.
const WRITES = [
  "setValue",
  "deleteValue",
  "updateMessage",
  "deleteMessage",
  "injectMessage",
  "queueMessage",
  "queueTool",
  "terminate",
] as const

// terminate is the last one, and a caller that goes on working with the thread leaves it out.
const everyWrite = async (state: ThreadState, messageId: string, label: string, terminate = true) => {
  const outcomes: Record<string, string> = {}
  outcomes.setValue = await attempt(() => state.setValue(`${label}-key`, "written"))
  outcomes.deleteValue = await attempt(() => state.setValue("early", null))
  outcomes.updateMessage = await attempt(() => state.updateMessage(messageId, { content: `${label} edit` }))
  outcomes.deleteMessage = await attempt(() => state.deleteMessage(messageId))
  outcomes.injectMessage = await attempt(() => state.injectMessage({ role: "user", content: `${label} injection` }))
  outcomes.queueMessage = await attempt(() => state.queueMessage({ role: "user", content: `${label} queued` }))
  outcomes.queueTool = await attempt(() => state.queueTool("noop", {}))
  if (terminate) outcomes.terminate = await attempt(() => state.terminate())
  return outcomes
}

export const O01: Scenario = {
  name: "O01 refuses every write of a tool whose thread was recovered by force, and leaves the successor's thread as it was",
  requirements: ["0953e887", "e28dedf2"],
  run: async (driver) => {
    const entered = gate()
    const leave = gate()
    const wrote = gate()
    const exit = gate()
    const successorIn = gate()
    const successorLeave = gate()
    let outcomes: Record<string, string> = {}
    const stale = defineTool({
      description: "Wait, then write as the execution that lost the thread",
      execute: async (state: ThreadState) => {
        await state.setValue("early", "kept")
        const first = (await state.getMessages({ order: "asc" })).messages[0]
        entered.release()
        await leave.opened
        outcomes = await everyWrite(state, first?.id ?? "", "stale")
        wrote.release()
        await exit.opened
        return ok("returned by the stale tool")
      },
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_stale", name: "stale", arguments: {} }] },
      async () => {
        successorIn.release()
        await successorLeave.opened
        return { text: "the successor's reply" }
      },
    ])
    await usingPeer(driver, { provider, tools: { stale, noop } }, async (session, thread, peer) => {
      const old = quiet(session.send(thread, "A")).catch(() => undefined)
      await entered.opened
      await peer.forceRecover(thread)
      const successor = quiet(peer.send(thread, "B"))
      await successorIn.opened
      const before = await peer.inspect(thread)
      expect(before).toMatchObject({
        status: { state: "running", reason: null },
        claim: { flowId: expect.any(String) },
      })
      try {
        leave.release()
        await wrote.opened
        const after = await peer.inspect(thread)
        expect(outcomes).toEqual(all(WRITES, "FlowEnded"))
        expect(after).toEqual(before)
      } finally {
        exit.release()
        successorLeave.release()
      }
      expect(await successor).toMatchObject({ status: "idle", reason: "stop_on_response" })
      await old
      const stored = await contents(session, thread)
      expect(stored).toEqual(["A", null, "error", "B", "the successor's reply"])
      expect((await peer.inspect(thread)).values).toEqual({ early: "kept" })
    })
  },
}

export const O02: Scenario = {
  name: "O02 lets a tool and a hook of the execution that holds the thread make every write",
  requirements: [],
  run: async (driver) => {
    let fromTool: Record<string, string> = {}
    let fromHook: Record<string, string> = {}
    const writer = defineTool({
      description: "Write as the execution that holds the thread",
      execute: async (state: ThreadState) => {
        await state.setValue("early", "kept")
        const first = (await state.getMessages({ order: "asc" })).messages[0]
        fromTool = await everyWrite(state, first?.id ?? "", "owner", false)
        return ok("wrote")
      },
    })
    const hook = defineHook({
      hook: "after_create_message",
      id: "writer_hook",
      execute: async (state, message) => {
        if (message.content !== "the reply") return
        fromHook = {
          setValue: await attempt(() => state.setValue("hook-key", "written")),
          updateMessage: await attempt(() => state.updateMessage(message.id, { metadata: { seen: true } })),
          queueMessage: await attempt(() => state.queueMessage({ role: "assistant", content: "hook queued" })),
        }
      },
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_writer", name: "writer", arguments: {} }] },
      { text: "the reply" },
      { text: "after the queue" },
    ])
    await usingPeer(
      driver,
      { provider, tools: { writer, noop }, hooks: [hook], prompt: { hooks: ["writer_hook"] } },
      async (session, thread) => {
        await session.seed(thread, [{ role: "user", content: "seeded" }])
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle" })
        expect(fromTool).toEqual(
          all(
            WRITES.filter((name) => name !== "terminate"),
            "done",
          ),
        )
        expect(fromHook).toEqual({ setValue: "done", updateMessage: "done", queueMessage: "done" })
        const stored = await session.inspect(thread)
        expect(stored.values).toEqual({ "owner-key": "written", "hook-key": "written" })
        expect(stored.queue).toEqual([])
        const texts = stored.messages.map((message) => message.content)
        expect(texts).not.toContain("seeded")
        expect(texts).toEqual(expect.arrayContaining(["owner injection", "owner queued", "hook queued"]))
      },
    )
  },
}

export const O03: Scenario = {
  name: "O03 refuses the writes of a hook whose thread was recovered by force while the hook ran",
  requirements: ["0953e887"],
  run: async (driver) => {
    const entered = gate()
    const leave = gate()
    const wrote = gate()
    const exit = gate()
    let outcomes: Record<string, string> = {}
    const hook = defineHook({
      hook: "after_create_message",
      id: "stale_hook",
      execute: async (state, message) => {
        if (message.content !== "the reply") return
        entered.release()
        await leave.opened
        outcomes = {
          setValue: await attempt(() => state.setValue("hook-key", "written")),
          updateMessage: await attempt(() => state.updateMessage(message.id, { content: "stale hook edit" })),
          deleteMessage: await attempt(() => state.deleteMessage(message.id)),
          queueMessage: await attempt(() => state.queueMessage({ role: "user", content: "stale hook queued" })),
        }
        wrote.release()
        await exit.opened
      },
    })
    const provider = new ScriptedProvider([{ text: "the reply" }])
    await usingPeer(
      driver,
      { provider, hooks: [hook], prompt: { hooks: ["stale_hook"] } },
      async (session, thread, peer) => {
        const old = quiet(session.send(thread, "A")).catch(() => undefined)
        await entered.opened
        await peer.forceRecover(thread)
        const before = await peer.inspect(thread)
        expect(before).toMatchObject({ status: { state: "failed", reason: "execution_lost" }, claim: null })
        try {
          leave.release()
          await wrote.opened
          expect(outcomes).toEqual(all(["setValue", "updateMessage", "deleteMessage", "queueMessage"], "FlowEnded"))
          expect(await peer.inspect(thread)).toEqual(before)
        } finally {
          exit.release()
        }
        await old
      },
    )
  },
}

export const O04: Scenario = {
  name: "O04 refuses an update that a tool submitted before another session terminated the thread, and its later writes",
  requirements: ["e95fd065"],
  run: async (driver) => {
    const entered = gate()
    const inHook = gate()
    const releaseHook = gate()
    const leave = gate()
    const wrote = gate()
    const exit = gate()
    const outcomes: Record<string, string> = {}
    const pause = defineHook({
      hook: "before_update_message",
      id: "pause",
      execute: async (_state, _id, updates) => {
        inHook.release()
        await releaseHook.opened
        return updates
      },
    })
    const editor = defineTool({
      description: "Submit an update, wait, then write again",
      execute: async (state: ThreadState) => {
        const first = (await state.getMessages({ order: "asc" })).messages[0]
        const id = first?.id ?? ""
        const submitted = attempt(() => state.updateMessage(id, { content: "stale edit" }))
        await inHook.opened
        entered.release()
        await leave.opened
        outcomes.submittedUpdate = await submitted
        outcomes.setValue = await attempt(() => state.setValue("late", "yes"))
        outcomes.deleteMessage = await attempt(() => state.deleteMessage(id))
        wrote.release()
        await exit.opened
        return ok("returned")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_editor", name: "editor", arguments: {} }] }])
    await usingPeer(
      driver,
      { provider, tools: { editor }, hooks: [pause], prompt: { hooks: ["pause"] } },
      async (session, thread, peer) => {
        const run = quiet(session.send(thread, "A")).catch(() => undefined)
        await entered.opened
        await (await peer.state(thread)).terminate()
        const before = await peer.inspect(thread)
        expect(before.terminated).toEqual(expect.any(Number))
        try {
          releaseHook.release()
          leave.release()
          await wrote.opened
          expect(outcomes).toEqual(all(["submittedUpdate", "setValue", "deleteMessage"], "FlowEnded"))
          expect(await peer.inspect(thread)).toEqual(before)
        } finally {
          exit.release()
        }
        await run
        expect((await contents(session, thread))[0]).toBe("A")
      },
    )
  },
}

export const O08: Scenario = {
  name: "O08 refuses every call on a handle that a tool or a hook kept after it returned or threw, while the run goes on",
  requirements: [],
  run: async (driver) => {
    const held = gate()
    const release = gate()
    const kept: Record<string, ThreadState> = {}
    const keeper = defineTool({
      description: "Keep the handle and return",
      execute: async (state: ThreadState) => {
        kept.toolThatReturned = state
        return ok("kept")
      },
    })
    const thrower = defineTool({
      description: "Keep the handle and throw",
      execute: async (state: ThreadState) => {
        kept.toolThatThrew = state
        throw new Error("the tool failed after it kept its handle")
      },
    })
    const keepHook = defineHook({
      hook: "filter_messages",
      id: "keep_hook",
      execute: async (state, messages) => {
        kept.hookThatReturned ??= state
        return messages
      },
    })
    const throwHook = defineHook({
      hook: "after_system_message",
      id: "throw_hook",
      execute: async (state) => {
        if (kept.hookThatThrew !== undefined) return null
        kept.hookThatThrew = state
        throw new Error("the hook failed after it kept its handle")
      },
    })
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c_keeper", name: "keeper", arguments: {} },
          { id: "c_thrower", name: "thrower", arguments: {} },
        ],
      },
      async () => {
        held.release()
        await release.opened
        return { text: "done" }
      },
    ])
    await usingPeer(
      driver,
      {
        provider,
        tools: { keeper, thrower, noop },
        hooks: [keepHook, throwHook],
        prompt: { hooks: ["keep_hook", "throw_hook"] },
      },
      async (session, thread, peer) => {
        const run = quiet(session.send(thread, "go"))
        await held.opened
        const before = await peer.inspect(thread)
        const outcomes: Record<string, Record<string, string>> = {}
        try {
          for (const [name, state] of Object.entries(kept))
            outcomes[name] = {
              getValue: await attempt(() => state.getValue("anything")),
              setValue: await attempt(() => state.setValue(`late-${name}`, "yes")),
              injectMessage: await attempt(() => state.injectMessage({ role: "user", content: `late ${name}` })),
              queueTool: await attempt(() => state.queueTool("noop", {})),
            }
          const expired = all(["getValue", "setValue", "injectMessage", "queueTool"], "HandleExpired")
          expect(outcomes).toEqual({
            toolThatReturned: expired,
            toolThatThrew: expired,
            hookThatReturned: expired,
            hookThatThrew: expired,
          })
          expect(await peer.inspect(thread)).toEqual(before)
        } finally {
          release.release()
        }
        expect(await run).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
      },
    )
  },
}

export const O09: Scenario = {
  name: "O09 lets a tool and a hook use their handles across awaits for as long as they run",
  requirements: [],
  run: async (driver) => {
    const outcomes: Record<string, string> = {}
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
    const slow = defineTool({
      description: "Wait a turn of the event loop, then write",
      execute: async (state: ThreadState) => {
        await tick()
        outcomes.tool = await attempt(() => state.setValue("tool", "wrote"))
        return ok("slow")
      },
    })
    const hook = defineHook({
      hook: "filter_messages",
      id: "slow_hook",
      execute: async (state, messages) => {
        await tick()
        outcomes.hook ??= await attempt(() => state.setValue("hook", "wrote"))
        return messages
      },
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_slow", name: "slow", arguments: {} }] },
      { text: "done" },
    ])
    await usingPeer(
      driver,
      { provider, tools: { slow }, hooks: [hook], prompt: { hooks: ["slow_hook"] } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        expect(outcomes).toEqual({ tool: "done", hook: "done" })
        expect((await session.inspect(thread)).values).toEqual({ tool: "wrote", hook: "wrote" })
      },
    )
  },
}

export const O10: Scenario = {
  name: "O10 refuses a handle that a hook of an inbound message kept, after the hook returned and after the thread was terminated",
  requirements: ["04d1538b"],
  run: async (driver) => {
    let handle: ThreadState | undefined
    let executionSeen: unknown = "not called"
    const keep = defineHook({
      hook: "after_create_message",
      id: "keep",
      execute: async (state, message) => {
        if (message.content !== "first") return
        handle = state
        executionSeen = state.execution
      },
    })
    const provider = new ScriptedProvider([{ text: "done" }])
    await usingPeer(driver, { provider, hooks: [keep], agent: { hooks: ["keep"] } }, async (session, thread) => {
      expect(await session.send(thread, "first")).toMatchObject({ status: "idle" })
      expect(executionSeen).toBeNull()
      const kept = handle as ThreadState
      const afterReturn = await attempt(() => kept.injectMessage({ role: "user", content: "after the hook returned" }))
      await (await session.state(thread)).terminate()
      const afterTerminate = await attempt(() => kept.injectMessage({ role: "user", content: "after the terminate" }))
      // After the terminate two refusals apply, and either one may come first.
      expect({ afterReturn, afterTerminate }).toEqual({
        afterReturn: "HandleExpired",
        afterTerminate: expect.stringMatching(/^(HandleExpired|ThreadTerminated)$/),
      })
      expect(await contents(session, thread)).toEqual(["first", "done"])
    })
  },
}

export const O11: Scenario = {
  name: "O11 refuses at commit an update that a hook submitted before it returned and that would land after the run settled",
  requirements: [],
  run: async (driver) => {
    const inUpdate = gate()
    const releaseUpdate = gate()
    let submitted: Promise<string> | undefined
    const submit = defineHook({
      hook: "filter_messages",
      id: "submit",
      execute: async (state, messages) => {
        const first = messages[0]
        if (submitted === undefined && first !== undefined) {
          submitted = attempt(() => state.updateMessage(first.id, { content: "late edit" }))
          await inUpdate.opened
        }
        return messages
      },
    })
    const pause = defineHook({
      hook: "before_update_message",
      id: "pause",
      execute: async (_state, _id, updates) => {
        inUpdate.release()
        await releaseUpdate.opened
        return updates
      },
    })
    const provider = new ScriptedProvider([{ text: "done" }])
    await usingPeer(
      driver,
      { provider, hooks: [submit, pause], prompt: { hooks: ["submit", "pause"] } },
      async (session, thread, peer) => {
        expect(await session.send(thread, "A")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        const before = await peer.inspect(thread)
        releaseUpdate.release()
        const outcome = await submitted
        const after = await peer.inspect(thread)
        expect({ outcome, first: after.messages[0]?.content, revision: after.revision }).toEqual({
          outcome: expect.stringMatching(/^(HandleExpired|FlowEnded|ExecutionEnded)$/),
          first: "A",
          revision: before.revision,
        })
      },
    )
  },
}

export const O12: Scenario = {
  name: "O12 refuses at commit an injection that a hook of an inbound message submitted before the thread was terminated",
  requirements: [],
  run: async (driver) => {
    const inCreate = gate()
    const releaseCreate = gate()
    let submitted: Promise<string> | undefined
    const submit = defineHook({
      hook: "after_create_message",
      id: "submit",
      execute: async (state, message) => {
        if (message.content !== "first") return
        submitted = attempt(() => state.injectMessage({ role: "user", content: "nested", silent: true }))
        await inCreate.opened
      },
    })
    const pause = defineHook({
      hook: "before_create_message",
      id: "pause",
      execute: async (_state, message) => {
        if (message.content === "nested") {
          inCreate.release()
          await releaseCreate.opened
        }
        return message
      },
    })
    const provider = new ScriptedProvider([{ text: "done" }])
    await usingPeer(
      driver,
      { provider, hooks: [submit, pause], agent: { hooks: ["submit", "pause"] } },
      async (session, thread, peer) => {
        expect(await session.send(thread, "first")).toMatchObject({ status: "idle" })
        await (await session.state(thread)).terminate()
        const before = await peer.inspect(thread)
        releaseCreate.release()
        const outcome = await submitted
        expect(outcome).toMatch(/^(HandleExpired|FlowEnded|ThreadTerminated)$/)
        expect(await peer.inspect(thread)).toEqual(before)
        expect(await contents(peer, thread)).toEqual(["first", "done"])
      },
    )
  },
}
