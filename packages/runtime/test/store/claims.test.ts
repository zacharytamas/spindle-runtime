import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Fiber, FileSystem, Layer, Scheduler } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { PlatformLive, processId, SqliteLive } from "#platform"
import { appendMessages } from "../../scripts/store-fixtures.ts"
import { CLOSING } from "../../src/execution/run-status.ts"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { CallerHasOpenCalls, external, HandleExpired, type NewMessage, type QueueEntry } from "../../src/store/model.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { layer } from "../../src/store/sqlite.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"

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
    const store = yield* MessageStore
    const inserted = yield* store.insertMessage(
      threadId,
      { ...caller, id: crypto.randomUUID(), created_at: 0 },
      { flowId },
    )
    if (result)
      yield* store.insertMessage(
        threadId,
        { ...result, id: crypto.randomUUID(), created_at: 0 },
        { flowId, callerSeq: inserted.seq },
      )
  })

const rows = (threadId: string) =>
  Effect.flatMap(MessageStore, (store) =>
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
        const threadStore = yield* ThreadStore
        const runStore = yield* RunStore
        for (const pid of [processId, 0, -1]) {
          const holder = `previous-${pid}`
          const thread = yield* threadStore.createThread({ agentId: "assistant" })
          yield* SqlClient.use((sql) => sql`INSERT INTO holders (id,pid) VALUES (${holder},${pid})`).pipe(
            Effect.provide(SqliteLive({ filename })),
          )
          yield* runStore.admit(thread.id, message("pending"), claim("lost", holder), external)
          expect(yield* runStore.recoverLost(thread.id)).toEqual([thread.id])
          expect((yield* threadStore.getThread(thread.id)).status).toMatchObject({
            state: "failed",
            reason: "execution_lost",
          })
        }
      }).pipe(Effect.provide(storeAt(filename)))
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )
  it.effect("admit claims an idle thread for the caller and queues the entry, and a second admit only queues", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      yield* TestClock.adjust("1 second")
      const first = yield* runStore.admit(thread.id, message("one"), claim("flow-a"), external)
      const second = yield* runStore.admit(thread.id, message("two"), claim("flow-b", "holder-2"), external)
      expect([first.claimed, second.claimed]).toEqual([true, false])
      expect((yield* threadStore.getThread(thread.id)).status).toEqual({
        state: "running",
        since: 1_000_000,
        reason: null,
      })
      expect(yield* runStore.owned("holder-1")).toEqual(new Map([[thread.id, "flow-a"]]))
      expect((yield* runStore.owned("holder-2")).size).toBe(0)
      expect([first.queued.seq < second.queued.seq, yield* runStore.queueLength(thread.id)]).toEqual([true, 2])
      expect(yield* runStore.nextQueued(thread.id, { flowId: "flow-a" })).toEqual(first.queued)
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("admit claims a failed thread, which is how a recovery run starts", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      yield* runStore.admit(thread.id, message("first"), claim("flow-a"), external)
      yield* runStore.recoverLost(thread.id)
      yield* TestClock.adjust("2 seconds")
      expect((yield* runStore.admit(thread.id, message("again"), claim("flow-r"), external)).claimed).toBe(true)
      expect((yield* threadStore.getThread(thread.id)).status).toEqual({
        state: "running",
        since: 2_000_000,
        reason: null,
      })
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("admit refuses a terminated thread with ThreadTerminated and queues nothing", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      const terminated = yield* runStore.terminate(thread.id, external)
      const error = yield* Effect.flip(runStore.admit(thread.id, message("late"), claim("flow-t"), external))
      expect(error).toMatchObject({ _tag: "ThreadTerminated", threadId: thread.id, terminated })
      expect(yield* runStore.queueLength(thread.id)).toBe(0)
      expect((yield* threadStore.getThread(thread.id)).status.state).toBe("idle")
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
        Effect.flatMap(RunStore, (store) =>
          store.admit(threadId, message(flowId), claim(flowId, flowId), external),
        ).pipe(Effect.provide(storeAt(filename)))
      const results = yield* Effect.all([admitFrom("flow-1"), admitFrom("flow-2")], { concurrency: "unbounded" })
      expect(results.filter((result) => result.claimed)).toHaveLength(1)
      const length = Effect.flatMap(RunStore, (store) => store.queueLength(threadId))
      expect(yield* Effect.provide(length, storeAt(filename))).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("claim takes a released thread that still holds queued work, and nothing else", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      expect(yield* runStore.claim(thread.id, claim("flow-empty"))).toBe(false)
      const { queued } = yield* runStore.admit(thread.id, message("x"), claim("flow-a"), external)
      expect(yield* runStore.claim(thread.id, claim("flow-busy"))).toBe(false)
      yield* runStore.settle(
        thread.id,
        { flowId: "flow-a" },
        { state: "idle", reason: "aborted" },
        { continueIfQueued: false, closing: "" },
      )
      expect(yield* runStore.isQueued(thread.id, queued.seq)).toBe(true)
      expect(yield* runStore.claim(thread.id, claim("flow-b"))).toBe(true)
      expect(yield* runStore.owned("holder-1")).toEqual(new Map([[thread.id, "flow-b"]]))
      yield* runStore.settle(
        thread.id,
        { flowId: "flow-b" },
        { state: "failed", reason: "step_error" },
        { continueIfQueued: false, closing: "" },
      )
      yield* runStore.terminate(thread.id, external)
      expect(yield* runStore.claim(thread.id, claim("flow-c"))).toBe(false)
      expect(yield* runStore.isQueued(thread.id, queued.seq + 1)).toBe(false)
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("settle keeps a run going while the queue holds work and releases the thread once it is empty", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const messageStore = yield* MessageStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      const { queued } = yield* runStore.admit(thread.id, message("one"), claim("flow-a"), external)
      const idle = { state: "idle", reason: "stop_on_response" } as const
      const options = { continueIfQueued: true, closing: CLOSING.failed }
      expect(yield* runStore.settle(thread.id, { flowId: "flow-a" }, idle, options)).toBe("continue")
      expect((yield* threadStore.getThread(thread.id)).status.state).toBe("running")
      yield* messageStore.insertMessage(
        thread.id,
        { id: "m1", created_at: 1, role: "user", content: "one" },
        { flowId: "flow-a", dequeue: queued.seq },
      )
      yield* TestClock.adjust("3 seconds")
      expect(yield* runStore.settle(thread.id, { flowId: "flow-a" }, idle, options)).toBe("settled")
      expect((yield* threadStore.getThread(thread.id)).status).toEqual({
        state: "idle",
        since: 3_000_000,
        reason: "stop_on_response",
      })
      expect((yield* runStore.owned("holder-1")).size).toBe(0)
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect(
    "settle leaves queued work for the next trigger when the run stops, and refuses a flow that holds nothing",
    () =>
      Effect.gen(function* () {
        const threadStore = yield* ThreadStore
        const runStore = yield* RunStore
        const thread = yield* threadStore.createThread({ agentId: "assistant" })
        yield* runStore.admit(thread.id, message("one"), claim("flow-a"), external)
        const stopped = { state: "idle", reason: "aborted" } as const
        expect(
          yield* runStore.settle(thread.id, { flowId: "flow-other" }, stopped, {
            continueIfQueued: false,
            closing: "",
          }),
        ).toBe("superseded")
        expect(
          yield* runStore.settle(thread.id, { flowId: "flow-a" }, stopped, { continueIfQueued: false, closing: "" }),
        ).toBe("settled")
        expect(
          yield* runStore.settle(thread.id, { flowId: "flow-a" }, stopped, { continueIfQueued: false, closing: "" }),
        ).toBe("superseded")
        expect([
          (yield* threadStore.getThread(thread.id)).status.reason,
          yield* runStore.queueLength(thread.id),
        ]).toEqual(["aborted", 1])
      }).pipe(Effect.provide(inMemory)),
  )

  it.effect("settle gives each call of the run that has no result an error result and leaves earlier calls alone", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const messageStore = yield* MessageStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      yield* appendMessages(thread.id, [callsBy("assistant", "old")])
      yield* runStore.admit(thread.id, message("go"), claim("flow-a"), external)
      yield* insertCalls(thread.id, "flow-a", callsBy("assistant", "c1", "c2", "c3"), resultFor("c1"))
      yield* appendMessages(thread.id, [
        { role: "user", content: "seeded by the human side", tool_calls: JSON.stringify([{ id: "h1" }]) },
      ])
      const failed = { state: "failed", reason: "step_error" } as const
      expect(
        yield* runStore.settle(thread.id, { flowId: "flow-a" }, failed, {
          continueIfQueued: false,
          closing: CLOSING.failed,
        }),
      ).toBe("settled")
      expect(yield* rows(thread.id)).toEqual([
        ["assistant", null, null],
        ["assistant", null, null],
        ["tool", "c1", "success"],
        ["user", "seeded by the human side", null],
        ["tool", "c2", "error"],
        ["tool", "c3", "error"],
      ])
      const closed = (yield* messageStore.getMessages(thread.id, { order: "asc", includeSilent: true })).messages.slice(
        -2,
      )
      expect(closed[0]?.content).toContain("It does not know whether the tool ran")
      expect(closed.map((m) => [m.name, m.prompt, m.content, m.status])).toEqual([
        ["tool_c2", "assistant", CLOSING.failed, "completed"],
        ["tool_c3", "assistant", CLOSING.failed, "completed"],
      ])
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("recover settles a thread whose process is gone as lost and keeps its queue and its history", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const messageStore = yield* MessageStore
      const lost = yield* threadStore.createThread({ agentId: "assistant" })
      const live = yield* threadStore.createThread({ agentId: "assistant" })
      yield* runStore.acquireHolder({ id: "dead", pid: 2147483647 })
      yield* runStore.acquireHolder({ id: "alive", pid: processId })
      yield* runStore.admit(lost.id, message("x"), claim("flow-lost", "dead"), external)
      yield* runStore.admit(live.id, message("y"), claim("flow-live", "alive"), external)
      yield* insertCalls(lost.id, "flow-lost", callsBy("assistant", "c1", "c2"), resultFor("c1"))
      yield* runStore.admit(lost.id, message("z"), claim("flow-ignored"), external)
      yield* TestClock.adjust("2 seconds")
      expect(yield* runStore.recoverLost(live.id)).toEqual([])
      expect(yield* runStore.recoverLost()).toEqual([lost.id])
      expect((yield* threadStore.getThread(lost.id)).status).toEqual({
        state: "failed",
        since: 2_000_000,
        reason: "execution_lost",
      })
      expect((yield* threadStore.getThread(live.id)).status.state).toBe("running")
      expect(yield* rows(lost.id)).toEqual([
        ["assistant", null, null],
        ["tool", "c1", "success"],
        ["tool", "c2", "error"],
      ])
      expect(
        (yield* messageStore.getMessages(lost.id, { order: "asc", includeSilent: true })).messages.at(-1)?.content,
      ).toBe(CLOSING.lost)
      expect(yield* runStore.queueLength(lost.id)).toBe(2)
      expect(yield* runStore.recoverLost()).toEqual([])
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("a running thread whose holder was never registered counts as lost", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      yield* runStore.admit(thread.id, message("x"), claim("flow-a", "never-beat"), external)
      expect(yield* runStore.holderOf(thread.id)).toBeNull()
      expect(yield* runStore.recoverLost(thread.id)).toEqual([thread.id])
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("insertMessage with a flow fails with FlowEnded once that flow no longer holds the thread", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const messageStore = yield* MessageStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      const other = yield* threadStore.createThread({ agentId: "assistant" })
      yield* runStore.admit(thread.id, message("x"), claim("flow-a"), external)
      yield* runStore.admit(other.id, message("x"), claim("flow-b"), external)
      const insert = (threadId: string, id: string, flowId: string) =>
        messageStore.insertMessage(threadId, { id, created_at: 1, role: "assistant", content: id }, { flowId })
      yield* insert(thread.id, "kept", "flow-a")
      yield* runStore.settle(
        thread.id,
        { flowId: "flow-a" },
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
      yield* runStore.terminate(other.id, external)
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
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const messageStore = yield* MessageStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      const { queued } = yield* runStore.admit(thread.id, message("x"), claim("flow-a"), external)
      yield* messageStore.insertMessage(
        thread.id,
        { id: "taken", created_at: 1, role: "user", content: "seed" },
        external,
      )
      const taken = { id: "taken", created_at: 2, role: "user", content: "x" } as const
      expect(
        yield* Effect.flip(messageStore.insertMessage(thread.id, taken, { flowId: "flow-a", dequeue: queued.seq })),
      ).toMatchObject({
        _tag: "MessageIdTaken",
      })
      expect(yield* runStore.queueLength(thread.id)).toBe(1)
      const delivered = { id: "fresh", created_at: 2, role: "user", content: "x" } as const
      expect(
        (yield* messageStore.insertMessage(thread.id, delivered, { flowId: "flow-a", dequeue: queued.seq })).revision,
      ).toBe(2)
      expect(yield* runStore.queueLength(thread.id)).toBe(0)
      expect(
        yield* Effect.flip(
          messageStore.insertMessage(
            thread.id,
            { ...delivered, id: "again" },
            { flowId: "flow-a", dequeue: queued.seq },
          ),
        ),
      ).toMatchObject({ _tag: "QueueEntryGone" })
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("terminate settles a running run idle with aborted, closes its open calls, and keeps its queue", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      yield* runStore.admit(thread.id, message("x"), claim("flow-a"), external)
      yield* runStore.admit(thread.id, message("y"), claim("flow-b"), external)
      yield* insertCalls(thread.id, "flow-a", callsBy("assistant", "c1"))
      yield* TestClock.adjust("4 seconds")
      const terminated = yield* runStore.terminate(thread.id, external)
      const after = yield* threadStore.getThread(thread.id)
      expect([terminated, after.terminated, after.status]).toEqual([
        4_000_000,
        4_000_000,
        { state: "idle", since: 4_000_000, reason: "aborted" },
      ])
      expect(yield* rows(thread.id)).toEqual([
        ["assistant", null, null],
        ["tool", "c1", "error"],
      ])
      expect(yield* runStore.queueLength(thread.id)).toBe(2)
      expect((yield* runStore.owned("holder-1")).size).toBe(0)
    }).pipe(Effect.provide(inMemory)),
  )

  it.effect("records the holder with its process id until it shuts down", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const runStore = yield* RunStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* runStore.acquireHolder({ id: "h", pid: 4242 })
          yield* runStore.admit(thread.id, message("x"), claim("flow-a", "h"), external)
          yield* TestClock.adjust("1 second")
          expect(yield* runStore.holderOf(thread.id)).toEqual({ id: "h", pid: 4242 })
        }),
      )
      expect(yield* runStore.holderOf(thread.id)).toBeNull()
    }).pipe(Effect.provide(inMemory)),
  )

  it.live("a store call never yields to another fiber while it holds the connection", () =>
    Effect.gen(function* () {
      const threadStore = yield* ThreadStore
      const messageStore = yield* MessageStore
      const thread = yield* threadStore.createThread({ agentId: "assistant" })
      yield* appendMessages(
        thread.id,
        Array.from({ length: 50 }, (_, index) => ({ role: "user" as const, content: `m${index}` })),
      )
      const context = yield* Effect.context<MessageStore>()
      // This fiber yields to the scheduler after every operation, inside a store call too unless the store prevents it.
      const busy = yield* Effect.forkChild(
        Effect.forever(messageStore.history(thread.id)).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 1)),
      )
      // Code outside Effect, such as a tool that calls queueTool, runs between fiber turns.
      const exits = yield* Effect.promise(
        () =>
          new Promise<Array<Exit.Exit<number, unknown>>>((resolve) => {
            const found: Array<Exit.Exit<number, unknown>> = []
            const tick = () => {
              found.push(Effect.runSyncExitWith(context)(messageStore.revision(thread.id)))
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
