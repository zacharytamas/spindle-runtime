import type { Message } from "@standardagents/spec"
import { Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { type Inserted, type ThreadNotFound, ThreadStore } from "../store/ThreadStore.ts"

// Execution State section 2.2 and Runtime section 4: the history an execution reads is the thread's persisted
// messages at that moment, whoever wrote them. The execution keeps a copy and the thread revision it matches, and
// reads the whole history again only when the revision shows that someone else wrote.
export interface History {
  // The copy itself, which no tool or hook may get without copying it.
  readonly read: Effect.Effect<ReadonlyArray<Message>, ThreadNotFound | SqlError, ThreadStore>
  readonly inserted: (inserted: Inserted) => void
}

export const makeHistory = (threadId: string): History => {
  let copy: { revision: number; readonly messages: Array<Message> } | undefined
  return {
    read: Effect.gen(function* () {
      const store = yield* ThreadStore
      if (copy !== undefined && copy.revision === (yield* store.revision(threadId))) return copy.messages
      const fresh = yield* store.history(threadId)
      copy = { revision: fresh.revision, messages: [...fresh.messages] }
      return copy.messages
    }),
    // A revision at or below the copy's means a read after the insert already holds it. One past the copy's means
    // nobody else wrote in between. Anything else, or an insert that a caller's transaction may still roll back,
    // leaves the copy stale.
    inserted: ({ message, revision }) => {
      if (copy === undefined || revision === null || revision > copy.revision + 1) copy = undefined
      else if (revision === copy.revision + 1) {
        // The writer gets the same object back, and injectMessage hands it to the tool or hook that wrote it.
        copy.messages.push(structuredClone(message))
        copy.revision = revision
      }
    },
  }
}
