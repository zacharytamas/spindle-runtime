import { Effect } from "effect"
import { type Claim, type Queued, type QueueEntry, ThreadStore } from "../src/store/ThreadStore.ts"

export const admitEntry = (threadId: string, entry: QueueEntry, claim: Claim) =>
  ThreadStore.use((store) => store.admit(threadId, entry, claim))
export const drainEntries = (threadId: string, flowId: string) =>
  ThreadStore.use((store) =>
    Effect.gen(function* () {
      const delivered: Queued[] = []
      while (true) {
        const entry = yield* store.nextQueued(threadId)
        if (!entry) return delivered
        const message =
          entry.kind === "tool"
            ? { role: "assistant" as const, content: JSON.stringify({ toolName: entry.toolName, args: entry.args }) }
            : entry.message
        yield* store.insertMessage(
          threadId,
          { role: message.role, content: message.content, id: crypto.randomUUID(), created_at: entry.queuedAt },
          { dequeue: entry.seq, flowId },
        )
        delivered.push(entry)
      }
    }),
  )
