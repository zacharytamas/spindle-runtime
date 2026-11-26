import { Effect } from "effect"
import { nowMicros } from "../src/store/database.ts"
import { MessageStore } from "../src/store/MessageStore.ts"
import {
  type Claim,
  external,
  type NewMessage,
  type Queued,
  type QueueEntry,
  ThreadTerminated,
} from "../src/store/model.ts"
import { RunStore } from "../src/store/RunStore.ts"
import { ThreadStore } from "../src/store/ThreadStore.ts"

export const admitEntry = (threadId: string, entry: QueueEntry, claim: Claim) =>
  RunStore.use((store) => store.admit(threadId, entry, claim, external))
export const drainEntries = (threadId: string, flowId: string) =>
  Effect.gen(function* () {
    const store = yield* RunStore
    const messages = yield* MessageStore
    const delivered: Queued[] = []
    while (true) {
      const entry = yield* store.nextQueued(threadId, { flowId })
      if (!entry) return delivered
      const message =
        entry.kind === "tool"
          ? { role: "assistant" as const, content: JSON.stringify({ toolName: entry.toolName, args: entry.args }) }
          : entry.message
      yield* messages.insertMessage(
        threadId,
        { role: message.role, content: message.content, id: crypto.randomUUID(), created_at: entry.queuedAt },
        { dequeue: entry.seq, flowId },
      )
      delivered.push(entry)
    }
  })

export const appendMessages = (threadId: string, drafts: ReadonlyArray<NewMessage>) =>
  ThreadStore.use((threads) =>
    threads.transaction(
      Effect.gen(function* () {
        const messages = yield* MessageStore
        const thread = yield* threads.getThread(threadId)
        if (thread.terminated !== null) return yield* new ThreadTerminated({ threadId, terminated: thread.terminated })
        const created_at = yield* nowMicros
        const rows = []
        for (const draft of drafts) {
          const inserted = yield* messages.insertMessage(
            threadId,
            { ...draft, id: crypto.randomUUID(), created_at },
            external,
          )
          rows.push(inserted.message)
        }
        return rows
      }),
    ),
  )
export const startRun = (threadId: string, claim: Claim) =>
  Effect.gen(function* () {
    const store = yield* RunStore
    if (!(yield* store.claim(threadId, claim)))
      yield* store.admit(threadId, { kind: "message", message: { role: "user", content: "trigger" } }, claim, external)
    return (yield* ThreadStore.use((threads) => threads.getThread(threadId))).status
  })
export const settleRun = (threadId: string, claim: Claim, outcome: { state: "idle" | "failed"; reason: string }) =>
  Effect.gen(function* () {
    const store = yield* RunStore
    yield* store.settle(threadId, claim, outcome, { continueIfQueued: false, closing: "" })
    return (yield* ThreadStore.use((threads) => threads.getThread(threadId))).status
  })
