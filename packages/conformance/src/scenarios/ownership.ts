import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import type { LoadOptions, RuntimeDriver, RuntimeSession } from "../RuntimeDriver.ts"
import { ScriptedProvider } from "../ScriptedProvider.ts"
import { gate, history, ok, project, type Scenario, type Setup, sideOf } from "./step-loop.ts"

const using = async (
  driver: RuntimeDriver,
  setup: Setup,
  body: (session: RuntimeSession, thread: string, peer: RuntimeSession) => Promise<void>,
  options: LoadOptions = {},
) => {
  const session = await driver.load(project(setup), options)
  const peer = await session.peer()
  try {
    await body(session, await session.createThread("assistant"), peer)
  } finally {
    await peer.close()
    await session.close()
  }
}

// What a call on a ThreadState did: "done", or the tag of the typed error it failed with.
export const attempt = async (call: () => unknown): Promise<string> => {
  try {
    await call()
    return "done"
  } catch (error) {
    return typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : `untyped: ${error instanceof Error ? error.message : String(error)}`
  }
}

// A send that a failed expectation leaves behind is rejected when its session closes. Nothing awaits it then.
const quiet = <A>(promise: Promise<A>): Promise<A> => {
  promise.catch(() => undefined)
  return promise
}

const noop = defineTool({ description: "Do nothing", execute: async () => ok("noop") })

const contents = async (session: RuntimeSession, thread: string) =>
  (await session.messages(thread)).map((message) => (message.role === "tool" ? message.tool_status : message.content))

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

const all = (names: ReadonlyArray<string>, outcome: string) => Object.fromEntries(names.map((name) => [name, outcome]))

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

export const ownershipScenarios: ReadonlyArray<Scenario> = [
  {
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
      await using(driver, { provider, tools: { stale, noop } }, async (session, thread, peer) => {
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
  },
  {
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
      await using(
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
  },
  {
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
      await using(
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
  },
  {
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
      await using(
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
  },
  {
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
      await using(
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
  },
  {
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
      await using(driver, { provider, tools: { stubborn } }, async (session, thread, peer) => {
        const first = quiet(session.send(thread, "A")).catch(() => undefined)
        await entered.opened
        expect(await session.abort(thread)).toBe(true)
        await aborted.opened
        const whileToolRuns = (await (await peer.state(thread)).status()).state
        const second = quiet(session.send(thread, "B"))
        // The send is durable once its entry is in the queue or in the history. The poll only waits for that write.
        for (let tries = 0; tries < 500; tries++) {
          const stored = await peer.inspect(thread)
          if (stored.queue.length > 0 || stored.messages.some((message) => message.content === "B")) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        const beforeReturn = (await (await peer.state(thread)).status()).state
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
  },
  {
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
      await using(driver, { provider, tools: { stubborn } }, async (session, thread, peer) => {
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
  },
  {
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
      await using(
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
  },
  {
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
      await using(
        driver,
        { provider, tools: { slow }, hooks: [hook], prompt: { hooks: ["slow_hook"] } },
        async (session, thread) => {
          expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
          expect(outcomes).toEqual({ tool: "done", hook: "done" })
          expect((await session.inspect(thread)).values).toEqual({ tool: "wrote", hook: "wrote" })
        },
      )
    },
  },
  {
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
      await using(driver, { provider, hooks: [keep], agent: { hooks: ["keep"] } }, async (session, thread) => {
        expect(await session.send(thread, "first")).toMatchObject({ status: "idle" })
        expect(executionSeen).toBeNull()
        const kept = handle as ThreadState
        const afterReturn = await attempt(() =>
          kept.injectMessage({ role: "user", content: "after the hook returned" }),
        )
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
  },
  {
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
      await using(
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
  },
  {
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
      await using(
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
  },
  {
    name: "O13 records the flow of each message an execution writes and the caller of each tool result",
    requirements: [],
    run: async (driver) => {
      let flowSeen = ""
      const look = defineTool({
        description: "Read the flow id",
        execute: async (state: ThreadState) => {
          flowSeen = state.execution?.flowId ?? ""
          return ok("looked")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_look", name: "look", arguments: {} }] },
        { text: "done" },
      ])
      await using(driver, { provider, tools: { look } }, async (session, thread, peer) => {
        await session.seed(thread, [{ role: "user", content: "seeded" }])
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const rows = (await peer.inspect(thread)).messages
        const caller = rows.find((row) => row.role === "assistant" && row.content === null)
        expect(flowSeen).not.toBe("")
        // The human's message is left out: the decision does not say whether its delivery counts as a write of the flow.
        const written = rows.filter((row) => row.content !== "go")
        expect(written.map((row) => [row.role, row.content, row.flowId, row.callerSeq])).toEqual([
          ["user", "seeded", null, null],
          ["assistant", null, flowSeen, null],
          ["tool", "looked", flowSeen, caller?.seq],
          ["assistant", "done", flowSeen, null],
        ])
      })
    },
  },
  {
    name: "O14 closes the open call of a lost execution although a hook set the caller's prompt to null",
    requirements: ["286367b3"],
    run: async (driver) => {
      const entered = gate()
      const leave = gate()
      const hide = defineHook({
        hook: "before_create_message",
        id: "hide",
        execute: async (_state, message) => (message.tool_calls === null ? message : { ...message, prompt: null }),
      })
      const hold = defineTool({
        description: "Wait for the test",
        execute: async () => {
          entered.release()
          await leave.opened
          return ok("returned")
        },
      })
      const provider = new ScriptedProvider([{ toolCalls: [{ id: "y", name: "hold", arguments: {} }] }])
      await using(
        driver,
        { provider, tools: { hold }, hooks: [hide], prompt: { hooks: ["hide"] } },
        async (session, thread, peer) => {
          const run = quiet(session.send(thread, "A")).catch(() => undefined)
          await entered.opened
          try {
            const before = await peer.messages(thread)
            expect(before.map((message) => [message.role, message.prompt])).toEqual([
              ["user", null],
              ["assistant", null],
            ])
            await peer.forceRecover(thread)
            expect((await peer.messages(thread)).map((m) => [m.role, m.tool_call_id, m.tool_status])).toEqual([
              ["user", null, null],
              ["assistant", null, null],
              ["tool", "y", "error"],
            ])
          } finally {
            leave.release()
          }
          await run
        },
      )
    },
  },
  {
    name: "O15 stores exactly one result for a completed call whose id holds a NUL character",
    requirements: ["41278e5e"],
    run: async (driver) => {
      const id = "a\u0000b"
      const once = defineTool({ description: "Run once", execute: async () => ok("once") })
      const provider = new ScriptedProvider([{ toolCalls: [{ id, name: "once", arguments: {} }] }, { text: "done" }])
      await using(driver, { provider, tools: { once } }, async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const results = (await session.messages(thread)).filter((message) => message.role === "tool")
        expect(results.map((m) => [m.tool_call_id, m.tool_status, m.content])).toEqual([[id, "success", "once"]])
        expect(history(provider.requests[1]).map(sideOf)).toEqual([
          ["user", "go"],
          ["assistant", null, [id]],
          ["tool", id],
        ])
      })
    },
  },
  {
    name: "O16 gives two open callers that reuse one call id a closing result each, and the next request pairs each with its caller",
    requirements: ["41278e5e"],
    run: async (driver) => {
      const entered = gate()
      const leave = gate()
      const first = defineTool({ description: "Answer the first call", execute: async () => ok("first answer") })
      const second = defineTool({
        description: "Delete the first call's result, then wait",
        execute: async (state: ThreadState) => {
          const earlier = (await state.getMessages({ order: "asc" })).messages.find((m) => m.role === "tool")
          await state.deleteMessage(earlier?.id ?? "")
          entered.release()
          await leave.opened
          return ok("second answer")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "dup", name: "first", arguments: {} }] },
        { toolCalls: [{ id: "dup", name: "second", arguments: {} }] },
        { text: "after the recovery" },
      ])
      await using(
        driver,
        { provider, tools: { first, second }, prompt: { includeChat: true, includePastTools: true } },
        async (session, thread, peer) => {
          const run = quiet(session.send(thread, "go")).catch(() => undefined)
          await entered.opened
          try {
            await peer.forceRecover(thread)
          } finally {
            leave.release()
          }
          await run
          const rows = (await peer.inspect(thread)).messages
          const callers = rows.filter((row) => row.role === "assistant")
          expect(rows.filter((row) => row.role === "tool").map((row) => row.callerSeq)).toEqual(
            callers.map((row) => row.seq),
          )
          expect(await peer.send(thread, "again")).toMatchObject({ status: "idle", reason: "stop_on_response" })
          expect(history(provider.requests[2]).map(sideOf)).toEqual([
            ["user", "go"],
            ["assistant", null, ["dup"]],
            ["tool", "dup"],
            ["assistant", null, ["dup"]],
            ["tool", "dup"],
            ["user", "again"],
          ])
        },
      )
    },
  },
  {
    name: "O17 refuses to delete a message that holds an open call of a running execution, from the tool and from another session",
    requirements: ["41278e5e"],
    run: async (driver) => {
      const entered = gate()
      const leave = gate()
      let caller = ""
      let fromTool = ""
      const hold = defineTool({
        description: "Try to delete the message that holds this call, then wait",
        execute: async (state: ThreadState) => {
          caller = state.execution?.messageHistory.findLast((message) => message.tool_calls !== null)?.id ?? ""
          fromTool = await attempt(() => state.deleteMessage(caller))
          entered.release()
          await leave.opened
          return ok("the effect happened")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_hold", name: "hold", arguments: {} }] },
        { text: "done" },
      ])
      await using(driver, { provider, tools: { hold } }, async (session, thread, peer) => {
        const run = quiet(session.send(thread, "go"))
        await entered.opened
        let fromPeer = ""
        try {
          fromPeer = await attempt(async () => (await peer.state(thread)).deleteMessage(caller))
        } finally {
          leave.release()
        }
        expect(await run).toMatchObject({ status: "idle", steps: 2 })
        expect({ fromTool, fromPeer }).toEqual({ fromTool: "CallerHasOpenCalls", fromPeer: "CallerHasOpenCalls" })
        expect((await session.messages(thread)).map((m) => [m.role, m.tool_call_id, m.tool_status])).toEqual([
          ["user", null, null],
          ["assistant", null, null],
          ["tool", "c_hold", "success"],
          ["assistant", null, null],
        ])
      })
    },
  },
  {
    name: "O18 deletes a message whose calls all have results, with those results, once its execution has settled",
    requirements: [],
    run: async (driver) => {
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_noop", name: "noop", arguments: {} }] },
        { text: "done" },
      ])
      await using(driver, { provider, tools: { noop } }, async (session, thread, peer) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const caller = (await session.messages(thread)).find((message) => message.tool_calls !== null)
        expect(await attempt(async () => (await peer.state(thread)).deleteMessage(caller?.id ?? ""))).toBe("done")
        expect(await contents(session, thread)).toEqual(["go", "done"])
      })
    },
  },
  {
    name: "O19 refuses an update, a delete, and a key-value write from outside on a terminated thread, and any write of an older handle",
    requirements: ["dc7d7df0", "9090af10"],
    run: async (driver) => {
      const provider = new ScriptedProvider([{ text: "first reply" }])
      await using(driver, { provider }, async (session, thread, peer) => {
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
  },
  {
    name: "O20 stores a message that a new handle injects into a terminated thread, and lets it read the thread",
    requirements: [],
    run: async (driver) => {
      const provider = new ScriptedProvider([{ text: "first reply" }])
      await using(driver, { provider }, async (session, thread, peer) => {
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
  },
  ...(["send", "queueMessage"] as const).map(
    (method): Scenario => ({
      name: `O21 settles a same-turn abort after ${method} on an idle thread`,
      requirements: [],
      run: async (driver) => {
        const provider = new ScriptedProvider([{ text: "reply" }, { text: "second reply" }])
        await using(driver, { provider }, async (session, thread, peer) => {
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
  ),
]
