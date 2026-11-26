import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, FileSystem, Layer, Scheduler } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { PlatformLive, processId, SqliteLive } from "#platform"
import { CLOSING } from "../../src/execution/run-status.ts"
import { layer } from "../../src/store/sqlite.ts"
import {
  CallerHasOpenCalls,
  callerSequence,
  HandleExpired,
  type NewMessage,
  type QueueEntry,
  ThreadStore,
} from "../../src/store/ThreadStore.ts"

const storeAt = (filename: string) => Layer.fresh(layer.pipe(Layer.provide(SqliteLive({ filename }))))
const inMemory = storeAt(":memory:")

const message = (content: string): QueueEntry => ({ kind: "message", message: { role: "user", content } })

const claim = (flowId: string, holder = "holder-1") => ({ holder, flowId })

const callsBy = (prompt: string, ...ids: Array<string>): NewMessage => ({
  role: "assistant",
  content: null,
  prompt,
  tool_calls: JSON.stringify(
    ids.map((id) => ({ id, type: "function", function: { name: `tool_${id}`, arguments: "{}" } })),
  ),
})

const resultFor = (id: string): NewMessage => ({
  role: "tool",
  content: "done",
  name: `tool_${id}`,
  tool_call_id: id,
  tool_status: "success",
})

const insertCalls = (threadId: string, flowId: string, caller: NewMessage, result?: NewMessage) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    const inserted = yield* store.insertMessage(
      threadId,
      { ...caller, id: crypto.randomUUID(), created_at: 0 },
      { flowId },
    )
    if (result)
      yield* store.insertMessage(
        threadId,
        { ...result, id: crypto.randomUUID(), created_at: 0 },
        { flowId, callerSeq: callerSequence(inserted.message) },
      )
  })

const rows = (threadId: string) =>
  Effect.flatMap(ThreadStore, (store) =>
    Effect.map(store.getMessages(threadId, { order: "asc", includeSilent: true }), (result) =>
      result.messages.map((m) => [m.role, m.role === "tool" ? m.tool_call_id : m.content, m.tool_status ?? null]),
    ),
  )

describe("ThreadStore claims", () => {
  it("explains expired handles and refusals to delete open calls", () => {
    expect(new HandleExpired().message).toMatch(/handle.*expired.*current/i)
    expect(new CallerHasOpenCalls({ messageId: "m1" }).message).toMatch(/m1.*open.*settle/i)
  })
  it.effect("recovers unregistered holders with this process id or a nonpositive pid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const filename = `${yield* fs.makeTempDirectoryScoped({ prefix: "spindle-stale-" })}/spindle.db`
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore
        for (const pid of [processId, 0, -1]) {
          const holder = `previous-${pid}`
          const thread = yield* store.createThread({ agentId: "assistant" })
          yield* SqlClient.use((sql) => sql`INSERT INTO holders (id,pid) VALUES (${holder},${pid})`).pipe(
            Effect.provide(SqliteLive({ filename })),
          )
          yield* store.admit(thread.id, message("pending"), claim("lost", holder))
          expect(yield* store.recover(thread.id)).toEqual([thread.id])
          expect((yield* store.getThread(thread.id)).status).toMatchObject({
            state: "failed",
            reason: "execution_lost",
          })
        }
      }).pipe(Effect.provide(storeAt(filename)))
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )
  it.effect("admit claims an idle thread for the caller and queues the entry, and a second admit only queues", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      yield* TestClock.adjust("1 second")
      const first = yield* store.admit(thread.id, message("one"), claim("flow-a"))
      const second = yield* store.admit(thread.id, message("two"), claim("flow-b", "holder-2"))
      expect([first.claimed, second.claimed]).toEqual([true, false])
      expect((yield* store.getThread(thread.id)).status).toEqual({ state: "running", since: 1_000_000, reason: null })
      expect(yield* store.owned("holder-1")).toEqual(new Map([[thread.id, "flow-a"]]))
      expect((yield* store.owned("holder-2")).size).toBe(0)
      expect([first.queued.seq < second.queued.seq, yield* store.queueLength(thread.id)]).toEqual([true, 2])
      expect(yield* store.nextQueued(thread.id)).toEqual(first.queued)
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("admit claims a failed thread, which is how a recovery run starts", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      yield* store.admit(thread.id, message("first"), claim("flow-a"))
      yield* store.recover(thread.id)
      yield* TestClock.adjust("2 seconds")
      expect((yield* store.admit(thread.id, message("again"), claim("flow-r"))).claimed).toBe(true)
      expect((yield* store.getThread(thread.id)).status).toEqual({ state: "running", since: 2_000_000, reason: null })
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("admit refuses a terminated thread with ThreadTerminated and queues nothing", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      const terminated = yield* store.terminate(thread.id)
      const error = yield* Effect.flip(store.admit(thread.id, message("late"), claim("flow-t")))
      expect(error).toMatchObject({ _tag: "ThreadTerminated", threadId: thread.id, terminated })
      expect(yield* store.queueLength(thread.id)).toBe(0)
      expect((yield* store.getThread(thread.id)).status.state).toBe("idle")
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("two connections to one file that admit to one idle thread claim it once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const filename = `${yield* fs.makeTempDirectoryScoped({ prefix: "spindle-claims-" })}/spindle.db`
      const threadId = yield* Effect.flatMap(ThreadStore, (store) =>
        Effect.map(store.createThread({ agentId: "assistant" }), (thread) => thread.id),
      ).pipe(Effect.provide(storeAt(filename)))
      const admitFrom = (flowId: string) =>
        Effect.flatMap(ThreadStore, (store) => store.admit(threadId, message(flowId), claim(flowId, flowId))).pipe(
          Effect.provide(storeAt(filename)),
        )
      const results = yield* Effect.all([admitFrom("flow-1"), admitFrom("flow-2")], { concurrency: "unbounded" })
      expect(results.filter((result) => result.claimed)).toHaveLength(1)
      const length = Effect.flatMap(ThreadStore, (store) => store.queueLength(threadId))
      expect(yield* Effect.provide(length, storeAt(filename))).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("claim takes a released thread that still holds queued work, and nothing else", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      expect(yield* store.claim(thread.id, claim("flow-empty"))).toBe(false)
      const { queued } = yield* store.admit(thread.id, message("x"), claim("flow-a"))
      expect(yield* store.claim(thread.id, claim("flow-busy"))).toBe(false)
      yield* store.settle(
        thread.id,
        "flow-a",
        { state: "idle", reason: "aborted" },
        { continueIfQueued: false, closing: "" },
      )
      expect(yield* store.isQueued(thread.id, queued.seq)).toBe(true)
      expect(yield* store.claim(thread.id, claim("flow-b"))).toBe(true)
      expect(yield* store.owned("holder-1")).toEqual(new Map([[thread.id, "flow-b"]]))
      yield* store.settle(
        thread.id,
        "flow-b",
        { state: "failed", reason: "step_error" },
        { continueIfQueued: false, closing: "" },
      )
      yield* store.terminate(thread.id)
      expect(yield* store.claim(thread.id, claim("flow-c"))).toBe(false)
      expect(yield* store.isQueued(thread.id, queued.seq + 1)).toBe(false)
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("settle keeps a run going while the queue holds work and releases the thread once it is empty", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      const { queued } = yield* store.admit(thread.id, message("one"), claim("flow-a"))
      const idle = { state: "idle", reason: "stop_on_response" } as const
      const options = { continueIfQueued: true, closing: CLOSING.failed }
      expect(yield* store.settle(thread.id, "flow-a", idle, options)).toBe("continue")
      expect((yield* store.getThread(thread.id)).status.state).toBe("running")
      yield* store.insertMessage(
        thread.id,
        { id: "m1", created_at: 1, role: "user", content: "one" },
        { flowId: "flow-a", dequeue: queued.seq },
      )
      yield* TestClock.adjust("3 seconds")
      expect(yield* store.settle(thread.id, "flow-a", idle, options)).toBe("settled")
      expect((yield* store.getThread(thread.id)).status).toEqual({
        state: "idle",
        since: 3_000_000,
        reason: "stop_on_response",
      })
      expect((yield* store.owned("holder-1")).size).toBe(0)
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect(
    "settle leaves queued work for the next trigger when the run stops, and refuses a flow that holds nothing",
    () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* store.admit(thread.id, message("one"), claim("flow-a"))
        const stopped = { state: "idle", reason: "aborted" } as const
        expect(yield* store.settle(thread.id, "flow-other", stopped, { continueIfQueued: false, closing: "" })).toBe(
          "superseded",
        )
        expect(yield* store.settle(thread.id, "flow-a", stopped, { continueIfQueued: false, closing: "" })).toBe(
          "settled",
        )
        expect(yield* store.settle(thread.id, "flow-a", stopped, { continueIfQueued: false, closing: "" })).toBe(
          "superseded",
        )
        expect([(yield* store.getThread(thread.id)).status.reason, yield* store.queueLength(thread.id)]).toEqual([
          "aborted",
          1,
        ])
      }).pipe(Effect.provide(inMemory)),
  )

  it.effect("settle gives each call of the run that has no result an error result and leaves earlier calls alone", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      yield* store.appendMessages(thread.id, [callsBy("assistant", "old")])
      yield* store.admit(thread.id, message("go"), claim("flow-a"))
      yield* insertCalls(thread.id, "flow-a", callsBy("assistant", "c1", "c2", "c3"), resultFor("c1"))
      yield* store.appendMessages(thread.id, [
        { role: "user", content: "seeded by the human side", tool_calls: JSON.stringify([{ id: "h1" }]) },
      ])
      const failed = { state: "failed", reason: "step_error" } as const
      expect(
        yield* store.settle(thread.id, "flow-a", failed, { continueIfQueued: false, closing: CLOSING.failed }),
      ).toBe("settled")
      expect(yield* rows(thread.id)).toEqual([
        ["assistant", null, null],
        ["assistant", null, null],
        ["tool", "c1", "success"],
        ["user", "seeded by the human side", null],
        ["tool", "c2", "error"],
        ["tool", "c3", "error"],
      ])
      const closed = (yield* store.getMessages(thread.id, { order: "asc", includeSilent: true })).messages.slice(-2)
      expect(closed[0]?.content).toContain("It does not know whether the tool ran")
      expect(closed.map((m) => [m.name, m.prompt, m.content, m.status])).toEqual([
        ["tool_c2", "assistant", CLOSING.failed, "completed"],
        ["tool_c3", "assistant", CLOSING.failed, "completed"],
      ])
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("recover settles a thread whose process is gone as lost and keeps its queue and its history", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const lost = yield* store.createThread({ agentId: "assistant" })
      const live = yield* store.createThread({ agentId: "assistant" })
      yield* store.registerHolder({ id: "dead", pid: 2147483647 })
      yield* store.registerHolder({ id: "alive", pid: processId })
      yield* store.admit(lost.id, message("x"), claim("flow-lost", "dead"))
      yield* store.admit(live.id, message("y"), claim("flow-live", "alive"))
      yield* insertCalls(lost.id, "flow-lost", callsBy("assistant", "c1", "c2"), resultFor("c1"))
      yield* store.admit(lost.id, message("z"), claim("flow-ignored"))
      yield* TestClock.adjust("2 seconds")
      expect(yield* store.recover(live.id)).toEqual([])
      expect(yield* store.recover()).toEqual([lost.id])
      expect((yield* store.getThread(lost.id)).status).toEqual({
        state: "failed",
        since: 2_000_000,
        reason: "execution_lost",
      })
      expect((yield* store.getThread(live.id)).status.state).toBe("running")
      expect(yield* rows(lost.id)).toEqual([
        ["assistant", null, null],
        ["tool", "c1", "success"],
        ["tool", "c2", "error"],
      ])
      expect((yield* store.getMessages(lost.id, { order: "asc", includeSilent: true })).messages.at(-1)?.content).toBe(
        CLOSING.lost,
      )
      expect(yield* store.queueLength(lost.id)).toBe(2)
      expect(yield* store.recover()).toEqual([])
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("a running thread whose holder was never registered counts as lost", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      yield* store.admit(thread.id, message("x"), claim("flow-a", "never-beat"))
      expect(yield* store.holderOf(thread.id)).toBeNull()
      expect(yield* store.recover(thread.id)).toEqual([thread.id])
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("insertMessage with a flow fails with FlowEnded once that flow no longer holds the thread", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      const other = yield* store.createThread({ agentId: "assistant" })
      yield* store.admit(thread.id, message("x"), claim("flow-a"))
      yield* store.admit(other.id, message("x"), claim("flow-b"))
      const insert = (threadId: string, id: string, flowId: string) =>
        store.insertMessage(threadId, { id, created_at: 1, role: "assistant", content: id }, { flowId })
      yield* insert(thread.id, "kept", "flow-a")
      yield* store.settle(
        thread.id,
        "flow-a",
        { state: "idle", reason: "stop_on_response" },
        {
          continueIfQueued: false,
          closing: "",
        },
      )
      expect(yield* Effect.flip(insert(thread.id, "late", "flow-a"))).toMatchObject({
        _tag: "FlowEnded",
        why: "superseded",
      })
      yield* store.terminate(other.id)
      expect(yield* Effect.flip(insert(other.id, "late", "flow-b"))).toMatchObject({
        _tag: "FlowEnded",
        why: "terminated",
      })
      expect((yield* rows(thread.id)).map((row) => row[1])).toEqual(["kept"])
      expect(yield* rows(other.id)).toEqual([])
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("insertMessage removes the entry it delivers in its own transaction, and a failed insert keeps it", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      const { queued } = yield* store.admit(thread.id, message("x"), claim("flow-a"))
      yield* store.insertMessage(thread.id, { id: "taken", created_at: 1, role: "user", content: "seed" })
      const taken = { id: "taken", created_at: 2, role: "user", content: "x" } as const
      expect(
        yield* Effect.flip(store.insertMessage(thread.id, taken, { flowId: "flow-a", dequeue: queued.seq })),
      ).toMatchObject({
        _tag: "MessageIdTaken",
      })
      expect(yield* store.queueLength(thread.id)).toBe(1)
      const delivered = { id: "fresh", created_at: 2, role: "user", content: "x" } as const
      expect(
        (yield* store.insertMessage(thread.id, delivered, { flowId: "flow-a", dequeue: queued.seq })).revision,
      ).toBe(2)
      expect(yield* store.queueLength(thread.id)).toBe(0)
      expect(
        yield* Effect.flip(
          store.insertMessage(thread.id, { ...delivered, id: "again" }, { flowId: "flow-a", dequeue: queued.seq }),
        ),
      ).toMatchObject({ _tag: "QueueEntryGone" })
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("terminate settles a running run idle with aborted, closes its open calls, and keeps its queue", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      yield* store.admit(thread.id, message("x"), claim("flow-a"))
      yield* store.admit(thread.id, message("y"), claim("flow-b"))
      yield* insertCalls(thread.id, "flow-a", callsBy("assistant", "c1"))
      yield* TestClock.adjust("4 seconds")
      const terminated = yield* store.terminate(thread.id)
      const after = yield* store.getThread(thread.id)
      expect([terminated, after.terminated, after.status]).toEqual([
        4_000_000,
        4_000_000,
        { state: "idle", since: 4_000_000, reason: "aborted" },
      ])
      expect(yield* rows(thread.id)).toEqual([
        ["assistant", null, null],
        ["tool", "c1", "error"],
      ])
      expect(yield* store.queueLength(thread.id)).toBe(2)
      expect((yield* store.owned("holder-1")).size).toBe(0)
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("records the holder with its process id until it shuts down", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      yield* store.registerHolder({ id: "h", pid: 4242 })
      yield* store.admit(thread.id, message("x"), claim("flow-a", "h"))
      yield* TestClock.adjust("1 second")
      expect(yield* store.holderOf(thread.id)).toEqual({ id: "h", pid: 4242 })
      yield* store.dropHolder("h")
      expect(yield* store.holderOf(thread.id)).toBeNull()
    }).pipe(Effect.provide(inMemory)),
  )

  it.live("a store call never yields to another fiber while it holds the connection", () =>
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const thread = yield* store.createThread({ agentId: "assistant" })
      yield* store.appendMessages(
        thread.id,
        Array.from({ length: 50 }, (_, index) => ({ role: "user" as const, content: `m${index}` })),
      )
      const context = yield* Effect.context<ThreadStore>()
      // This fiber yields to the scheduler after every operation, inside a store call too unless the store prevents it.
      const busy = yield* Effect.forkChild(
        Effect.forever(store.history(thread.id)).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1)),
      )
      // Code outside Effect, such as a tool that calls queueTool, runs between fiber turns.
      const exits = yield* Effect.promise(
        () =>
          new Promise<Array<Exit.Exit<number, unknown>>>((resolve) => {
            const found: Array<Exit.Exit<number, unknown>> = []
            const tick = () => {
              found.push(Effect.runSyncExitWith(context)(store.revision(thread.id)))
              if (found.length < 300) setTimeout(tick, 0)
              else resolve(found)
            }
            setTimeout(tick, 0)
          }),
      )
      yield* Fiber.interrupt(busy)
      expect(exits.filter((exit) => !Exit.isSuccess(exit))).toEqual([])
    }).pipe(Effect.provide(inMemory)),
  )
})
