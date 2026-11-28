import type { Message } from "@standardagents/spec"
import { Chunk, Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { MessageStore } from "../store/MessageStore.ts"
import type { HistoryRow, ThreadHistory, ThreadNotFound } from "../store/model.ts"

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
  readonly read: Effect.Effect<ThreadHistory, ThreadNotFound | SqlError, MessageStore>
  readonly since: (
    seq: number,
  ) => Effect.Effect<{ rows: ReadonlyArray<HistoryRow>; total: number }, ThreadNotFound | SqlError, MessageStore>
  readonly inserted: (inserted: HistoryRow & { readonly revision: number | null }) => void
  readonly updated: (message: Message) => void
  readonly deleted: (messageId: string) => void
}

export interface HistoryListeners {
  readonly onInsert?: (row: HistoryRow) => void
  readonly onUpdate?: (message: Message) => void
  readonly onDelete?: (messageId: string) => void
}

export const makeHistory = (threadId: string, listeners?: HistoryListeners): History => {
  let copy: { rows: Chunk.Chunk<HistoryRow>; revision: number } | undefined
  const snapshot = Effect.gen(function* () {
    const store = yield* MessageStore
    if (copy !== undefined && copy.revision === (yield* store.revision(threadId))) return copy
    // Never cache a read inside a transaction that may roll back.
    const read = yield* store.history(threadId)
    const rows = Chunk.fromIterable(read.rows)
    if (read.revision !== null) copy = { rows, revision: read.revision }
    return { rows, revision: read.revision }
  })
  return {
    read: Effect.map(snapshot, ({ rows, revision }) => ({ rows: Chunk.toReadonlyArray(rows), revision })),
    since: (seq) =>
      Effect.map(snapshot, ({ rows }) => {
        let start = rows.length
        while (start > 0 && Chunk.getUnsafe(rows, start - 1).seq >= seq) start--
        return { rows: Chunk.toReadonlyArray(Chunk.drop(rows, start)), total: rows.length }
      }),
    // A revision at or below the copy's means a read after the insert already holds it. One past the copy's means
    // nobody else wrote in between. Anything else, or an insert that a caller's transaction may still roll back,
    // leaves the copy stale.
    inserted: (row) => {
      listeners?.onInsert?.(row)
      const { message, revision, seq, callerSeq } = row
      if (copy === undefined || revision === null || revision > copy.revision + 1) copy = undefined
      // The writer gets the same message object back, and injectMessage hands it to the tool or hook that wrote it.
      else if (revision === copy.revision + 1) {
        copy = {
          revision,
          rows: Chunk.append(copy.rows, { message: copyMessage(message), seq, callerSeq }),
        }
      }
    },
    updated: (message) => {
      listeners?.onUpdate?.(message)
    },
    deleted: (messageId) => {
      listeners?.onDelete?.(messageId)
    },
  }
}
