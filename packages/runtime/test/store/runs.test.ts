import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { admitEntry, drainEntries } from "../../scripts/store-fixtures.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"

import { claim, inMemory, settleRun, storeAt, withDatabaseFile } from "./contract-fixtures.ts"

const startRun = (threadId: string) =>
  ThreadStore.use((store) =>
    Effect.gen(function* () {
      if (!(yield* store.claim(threadId, claim)))
        yield* store.admit(threadId, { kind: "message", message: { role: "user", content: "trigger" } }, claim)
      return (yield* store.getThread(threadId)).status
    }),
  )

describe("ThreadStore", () => {
  describe("run status", () => {
    it.effect("setStatus changes since only when the state or the reason changes", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* TestClock.adjust("1 second")
        const running = yield* startRun(thread.id)
        expect(running).toEqual({ state: "running", since: 1_000_000, reason: null })
        yield* TestClock.adjust("1 second")
        expect(yield* startRun(thread.id)).toEqual(running)
        yield* TestClock.adjust("1 second")
        const idle = yield* settleRun(thread.id, { state: "idle", reason: "stop_on_response" })
        expect(idle).toEqual({ state: "idle", since: 3_000_000, reason: "stop_on_response" })
        yield* TestClock.adjust("1 second")
        expect(yield* settleRun(thread.id, { state: "idle", reason: "stop_on_response" })).toEqual(idle)
        yield* TestClock.adjust("1 second")
        yield* startRun(thread.id)
        const stopTool = yield* settleRun(thread.id, { state: "idle", reason: "stop_tool" })
        expect(stopTool).toEqual({ state: "idle", since: 5_000_000, reason: "stop_tool" })
        expect((yield* store.getThread(thread.id)).status).toEqual(stopTool)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("the run status survives a restart with its since time, including a failed execution_lost status", () =>
      withDatabaseFile((filename) =>
        Effect.gen(function* () {
          const written = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            const thread = yield* store.createThread({ agentId: "assistant" })
            yield* TestClock.adjust("1 second")
            yield* startRun(thread.id)
            yield* TestClock.adjust("1 second")
            const status = yield* settleRun(thread.id, { state: "failed", reason: "execution_lost" })
            return { threadId: thread.id, status }
          }).pipe(Effect.provide(storeAt(filename)))
          expect(written.status).toEqual({ state: "failed", since: 2_000_000, reason: "execution_lost" })
          yield* TestClock.adjust("1 second")
          const status = yield* Effect.gen(function* () {
            const store = yield* ThreadStore
            return (yield* store.getThread(written.threadId)).status
          }).pipe(Effect.provide(storeAt(filename)))
          expect(status).toEqual(written.status)
        }),
      ),
    )
  })

  describe("queue", () => {
    it.effect("enqueue and takeQueue keep messages and tool calls in arrival order and empty the queue", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        const other = yield* store.createThread({ agentId: "assistant" })
        yield* admitEntry(thread.id, { kind: "message", message: { role: "user", content: "first" } }, claim)
        yield* admitEntry(other.id, { kind: "message", message: { role: "user", content: "elsewhere" } }, claim)
        yield* admitEntry(thread.id, { kind: "tool", toolName: "lookup", args: { q: "x" } }, claim)
        yield* admitEntry(
          thread.id,
          {
            kind: "message",
            message: { role: "assistant", content: "third", silent: true },
          },
          claim,
        )
        const taken = yield* drainEntries(thread.id, claim.flowId)
        expect(taken.map(({ seq: _, queuedAt: __, ...entry }) => entry)).toEqual([
          { kind: "message", message: { role: "user", content: "first" } },
          { kind: "tool", toolName: "lookup", args: { q: "x" } },
          { kind: "message", message: { role: "assistant", content: "third", silent: true } },
        ])
        expect(yield* drainEntries(thread.id, claim.flowId)).toEqual([])
        expect((yield* drainEntries(other.id, claim.flowId)).length).toBe(1)
      }).pipe(Effect.provide(inMemory)),
    )

    it.effect("takeQueue inside a failed transaction leaves the entries queued", () =>
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "assistant" })
        yield* admitEntry(thread.id, { kind: "tool", toolName: "lookup", args: {} }, claim)
        yield* Effect.flip(
          store.transaction(Effect.andThen(drainEntries(thread.id, claim.flowId), Effect.fail("crash"))),
        )
        expect((yield* drainEntries(thread.id, claim.flowId)).length).toBe(1)
      }).pipe(Effect.provide(inMemory)),
    )
  })
})
