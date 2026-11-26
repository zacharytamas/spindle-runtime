import type { Message } from "@standardagents/spec"
import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { type Inserted, type ThreadHistory, type ThreadNotFound, ThreadStore } from "../store/ThreadStore.ts"

// A stored message's metadata and attachments come from JSON.parse, so they hold only plain objects, arrays, and
// primitives. On Bun, structuredClone of a history took longer than reading it from the store, and this copy takes
// a tenth of that time. Object.fromEntries keeps a "__proto__" key that JSON.parse made as an own key.
const copyJson = (value: unknown): unknown =>
  typeof value !== "object" || value === null
    ? value
    : Array.isArray(value)
      ? value.map(copyJson)
      : Object.fromEntries(Object.entries(value).map(([key, member]) => [key, copyJson(member)]))

export const copyMessage = (message: Message) =>
  ({ ...message, metadata: copyJson(message.metadata), attachments: copyJson(message.attachments) }) as Message

// Execution State section 2.2 and Runtime section 4: the history an execution reads is the thread's persisted
// messages at that moment, whoever wrote them. The execution keeps a copy and the thread revision it matches, and
// reads the whole history again only when the revision shows that someone else wrote.
export interface History {
  // The copy itself, which no tool or hook may get without copying it. No later write changes an array it returned, so
  // a snapshot holds what the thread held when it was taken.
  readonly read: Effect.Effect<ThreadHistory, ThreadNotFound | SqlError, ThreadStore>
  readonly inserted: (inserted: Inserted) => void
}

export const makeHistory = (threadId: string): History => {
  let copy: (ThreadHistory & { revision: number }) | undefined
  return {
    read: Effect.gen(function* () {
      const store = yield* ThreadStore
      if (copy !== undefined && copy.revision === (yield* store.revision(threadId))) return copy
      // A read inside a caller's transaction may see writes that roll back, so the copy never keeps it.
      const read = yield* store.history(threadId)
      if (read.revision !== null) copy = { ...read, revision: read.revision }
      return read
    }),
    // A revision at or below the copy's means a read after the insert already holds it. One past the copy's means
    // nobody else wrote in between. Anything else, or an insert that a caller's transaction may still roll back,
    // leaves the copy stale.
    inserted: ({ message, revision, seq, callerSeq }) => {
      if (copy === undefined || revision === null || revision > copy.revision + 1) copy = undefined
      // The writer gets the same message object back, and injectMessage hands it to the tool or hook that wrote it.
      else if (revision === copy.revision + 1) {
        copy = { revision, messages: copy.messages.concat(copyMessage(message)), positions: new Map(copy.positions).set(message.id, { seq, callerSeq }) }
      }
    },
  }
}
