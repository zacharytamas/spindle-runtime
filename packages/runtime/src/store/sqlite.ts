import { Clock, Effect, Layer } from "effect"
import * as Migrator from "effect/sql/Migrator"
import { SqlClient } from "effect/sql/SqlClient"
import threads from "./migrations/0001_threads.ts"
import {
  findNotJson,
  type MessageRow,
  messageColumns,
  messageRow,
  type QueueRow,
  queuePayload,
  type ThreadRow,
  toMessage,
  toQueued,
  toThread,
} from "./schema.ts"
import { MessageNotFound, ThreadNotFound, ThreadStore, ValueNotJson } from "./ThreadStore.ts"

const migrate = Migrator.make({})({ loader: Migrator.fromRecord({ "0001_threads": threads }) })

const nowMicros = Effect.map(Clock.currentTimeNanos, (nanos) => Number(nanos / 1000n))

const first = <A, E>(rows: ReadonlyArray<A>, missing: () => E): Effect.Effect<A, E> =>
  rows[0] === undefined ? Effect.fail(missing()) : Effect.succeed(rows[0])

export const layer = Layer.effect(
  ThreadStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    // Both pragmas are per connection, and both SQLite clients hold one connection.
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA synchronous = FULL`
    yield* migrate

    const requireThread = (threadId: string) =>
      Effect.flatMap(sql`SELECT id FROM threads WHERE id = ${threadId}`, (rows) =>
        first(rows, () => new ThreadNotFound({ threadId })),
      )

    const selectMessages = (where: ReturnType<typeof sql.and>) =>
      sql<MessageRow>`SELECT ${sql.literal(messageColumns)} FROM messages WHERE ${where}`

    return ThreadStore.of({
      transaction: sql.withTransaction,

      createThread: (thread) =>
        sql.withTransaction(
          Effect.gen(function* () {
            if (thread.parentId != null) yield* requireThread(thread.parentId)
            const row = {
              id: crypto.randomUUID(),
              agent_id: thread.agentId,
              parent_id: thread.parentId ?? null,
              arguments: JSON.stringify(thread.arguments ?? {}),
              created_at: yield* nowMicros,
            }
            const inserted = yield* sql<ThreadRow>`INSERT INTO threads ${sql.insert(row)} RETURNING *`
            return toThread(yield* first(inserted, () => new ThreadNotFound({ threadId: row.id })))
          }),
        ),

      getThread: (threadId) =>
        Effect.flatMap(sql<ThreadRow>`SELECT * FROM threads WHERE id = ${threadId}`, (rows) =>
          Effect.map(
            first(rows, () => new ThreadNotFound({ threadId })),
            toThread,
          ),
        ),

      terminate: (threadId) =>
        Effect.gen(function* () {
          const now = yield* nowMicros
          const rows = yield* sql<{ terminated_at: number }>`
            UPDATE threads SET terminated_at = coalesce(terminated_at, ${now})
            WHERE id = ${threadId} RETURNING terminated_at`
          const row = yield* first(rows, () => new ThreadNotFound({ threadId }))
          return row.terminated_at
        }),

      setStatus: (threadId, status) =>
        Effect.gen(function* () {
          const reason = status.state === "running" ? null : status.reason
          const now = yield* nowMicros
          // SQLite evaluates every SET expression against the row as it was before the update.
          const rows = yield* sql<Pick<ThreadRow, "run_state" | "run_since" | "run_reason">>`
            UPDATE threads SET
              run_since = CASE WHEN run_state = ${status.state} AND run_reason IS ${reason} THEN run_since ELSE ${now} END,
              run_state = ${status.state},
              run_reason = ${reason}
            WHERE id = ${threadId} RETURNING run_state, run_since, run_reason`
          const row = yield* first(rows, () => new ThreadNotFound({ threadId }))
          return { state: row.run_state, since: row.run_since, reason: row.run_reason }
        }),

      appendMessages: (threadId, messages) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId)
            const createdAt = yield* nowMicros
            const rows = messages.map((message) => messageRow(threadId, crypto.randomUUID(), createdAt, message))
            for (const row of rows) yield* sql`INSERT INTO messages ${sql.insert(row)}`
            return rows.map(toMessage)
          }),
        ),

      getMessages: (threadId, options = {}) =>
        Effect.gen(function* () {
          const { limit, offset = 0, order = "desc", includeSilent = false, maxDepth } = options
          const where = sql.and([
            sql`thread_id = ${threadId}`,
            ...(includeSilent ? [] : [sql`silent = 0`]),
            ...(maxDepth === undefined ? [] : [sql`depth <= ${maxDepth}`]),
          ])
          const [count] = yield* sql<{ total: number }>`SELECT count(*) AS total FROM messages WHERE ${where}`
          const total = count?.total ?? 0
          const rows = yield* sql<MessageRow>`${selectMessages(where)}
            ORDER BY seq ${sql.literal(order === "asc" ? "ASC" : "DESC")} LIMIT ${limit ?? -1} OFFSET ${offset}`
          return { messages: rows.map(toMessage), total, hasMore: offset + rows.length < total }
        }),

      getMessage: (threadId, messageId) =>
        Effect.map(selectMessages(sql.and([sql`thread_id = ${threadId}`, sql`id = ${messageId}`])), (rows) =>
          rows[0] === undefined ? null : toMessage(rows[0]),
        ),

      updateMessage: (threadId, messageId, updates) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const where = sql.and([sql`thread_id = ${threadId}`, sql`id = ${messageId}`])
            const current = yield* first(
              yield* selectMessages(where),
              () => new MessageNotFound({ threadId, messageId }),
            )
            const metadata = JSON.stringify({ ...JSON.parse(current.metadata), ...updates.metadata })
            yield* sql`UPDATE messages SET content = ${updates.content ?? current.content}, metadata = ${metadata} WHERE ${where}`
            const updated = yield* selectMessages(where)
            return toMessage(yield* first(updated, () => new MessageNotFound({ threadId, messageId })))
          }),
        ),

      deleteMessage: (threadId, messageId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const deleted = yield* sql<{ tool_calls: string | null }>`
              DELETE FROM messages WHERE thread_id = ${threadId} AND id = ${messageId} RETURNING tool_calls`
            if (deleted[0] === undefined) return false
            const toolCalls = deleted[0].tool_calls
            if (toolCalls !== null)
              yield* sql`
                DELETE FROM messages WHERE thread_id = ${threadId} AND role = 'tool'
                AND tool_call_id IN (SELECT json_extract(value, '$.id') FROM json_each(${toolCalls}))`
            return true
          }),
        ),

      enqueue: (threadId, entry) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId)
            const queuedAt = yield* nowMicros
            const rows = yield* sql<QueueRow>`
              INSERT INTO queue ${sql.insert({ thread_id: threadId, kind: entry.kind, payload: queuePayload(entry), queued_at: queuedAt })}
              RETURNING seq, kind, payload, queued_at`
            return toQueued(yield* first(rows, () => new ThreadNotFound({ threadId })))
          }),
        ),

      takeQueue: (threadId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<QueueRow>`
              SELECT seq, kind, payload, queued_at FROM queue WHERE thread_id = ${threadId} ORDER BY seq`
            const last = rows.at(-1)
            if (last !== undefined) yield* sql`DELETE FROM queue WHERE thread_id = ${threadId} AND seq <= ${last.seq}`
            return rows.map(toQueued)
          }),
        ),

      getValue: (threadId, key) =>
        Effect.map(
          sql<{ value: string }>`SELECT value FROM kv WHERE thread_id = ${threadId} AND key = ${key}`,
          (rows) => (rows[0] === undefined ? null : JSON.parse(rows[0].value)),
        ),

      setValue: (threadId, key, value) => {
        if (value === null || value === undefined)
          return Effect.asVoid(sql`DELETE FROM kv WHERE thread_id = ${threadId} AND key = ${key}`)
        const notJson = findNotJson(value)
        if (notJson !== undefined) return Effect.fail(new ValueNotJson({ key, ...notJson }))
        return sql.withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId)
            yield* sql`
              INSERT INTO kv ${sql.insert({ thread_id: threadId, key, value: JSON.stringify(value) })}
              ON CONFLICT (thread_id, key) DO UPDATE SET value = excluded.value`
          }),
        )
      },
    })
  }),
)
