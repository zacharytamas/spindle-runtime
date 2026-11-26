import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import type { LoadOptions, RuntimeDriver, RuntimeSession } from "../RuntimeDriver.ts"
import { ScriptedProvider } from "../ScriptedProvider.ts"
import { gate, ok, project, type Scenario, type Setup } from "./step-loop.ts"

// A session looks for a terminate or a recovery from another session once in a fifth of this time. With a minute, no
// such look happens inside a scenario, so only the check the store makes when a write commits can refuse a stale write.
const SLOW_POLL: LoadOptions = { holderTimeoutMs: 60_000 }

const using = async (
  driver: RuntimeDriver,
  setup: Setup,
  body: (session: RuntimeSession, thread: string, peer: RuntimeSession) => Promise<void>,
  options: LoadOptions = SLOW_POLL,
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
]
