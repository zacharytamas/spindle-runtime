import { Clock, Effect, Layer } from "effect"
import * as Migrator from "effect/sql/Migrator"
import { BeginTransaction, SqlClient } from "effect/sql/SqlClient"
import threads from "./migrations/0001_threads.ts"
import {
  type MessageRow,
  messageColumns,
  messageRow,
  type QueueRow,
  queuePayload,
  runReasonColumn,
  stored,
  type ThreadRow,
  threadColumns,
  toJson,
  toMessage,
  toQueued,
  toStatus,
  toThread,
} from "./schema.ts"
import {
  InvalidMessagesQuery,
  KeyNotWellFormed,
  MessageIdTaken,
  MessageNotFound,
  ThreadNotFound,
  ThreadStore,
  ValueNotJson,
} from "./ThreadStore.ts"

const migrate = Migrator.make({})({ loader: Migrator.fromRecord({ "0001_threads": threads }) })

const nowMicros = Effect.map(Clock.currentTimeNanos, (nanos) => Number(nanos / 1000n))

const loneSurrogate = /[\uD800-\uDFFF]/u

// SQLite stores a key as UTF-8, which has no encoding for a lone surrogate, so two such keys would collide.
const isWellFormed = (key: string) => !loneSurrogate.test(key)

const json = (field: string, value: unknown): Effect.Effect<string, ValueNotJson> =>
  Effect.suspend(() => {
    const text = toJson(value)
    return typeof text === "string" ? Effect.succeed(text) : Effect.fail(new ValueNotJson({ field, ...text }))
  })

const isCount = (value: number) => Number.isSafeInteger(value) && value >= 0

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
              agent_id: stored(thread.agentId),
              parent_id: thread.parentId ?? null,
              arguments: yield* json("the thread arguments", thread.arguments ?? {}),
              created_at: yield* nowMicros,
            }
            const inserted =
              yield* sql<ThreadRow>`INSERT INTO threads ${sql.insert(row)} RETURNING ${sql.literal(threadColumns)}`
            return toThread(yield* first(inserted, () => new ThreadNotFound({ threadId: row.id })))
          }),
        ),

      getThread: (threadId) =>
        Effect.flatMap(
          sql<ThreadRow>`SELECT ${sql.literal(threadColumns)} FROM threads WHERE id = ${threadId}`,
          (rows) =>
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
          const reason = status.state === "running" ? null : stored(status.reason)
          const now = yield* nowMicros
          // SQLite evaluates every SET expression against the row as it was before the update.
          const rows = yield* sql<Pick<ThreadRow, "run_state" | "run_since" | "run_reason">>`
            UPDATE threads SET
              run_since = CASE WHEN run_state = ${status.state} AND run_reason IS ${reason} THEN run_since ELSE ${now} END,
              run_state = ${status.state},
              run_reason = ${reason}
            WHERE id = ${threadId} RETURNING run_state, run_since, ${sql.literal(runReasonColumn)}`
          const row = yield* first(rows, () => new ThreadNotFound({ threadId }))
          return toStatus(row)
        }),

      appendMessages: (threadId, messages) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId)
            const createdAt = yield* nowMicros
            const rows: Array<ReturnType<typeof messageRow>> = []
            for (const message of messages)
              rows.push(
                messageRow(threadId, crypto.randomUUID(), createdAt, message, {
                  attachments:
                    message.attachments == null ? null : yield* json("the message attachments", message.attachments),
                  metadata: yield* json("the message metadata", message.metadata ?? {}),
                }),
              )
            for (const row of rows) yield* sql`INSERT INTO messages ${sql.insert(row)}`
            return rows.map(toMessage)
          }),
        ),

      insertMessage: (threadId, message) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId)
            // Message ids are unique across threads, so an id that another thread holds is taken too.
            const taken = yield* sql`SELECT 1 FROM messages WHERE id = ${message.id}`
            if (taken.length > 0) return yield* new MessageIdTaken({ messageId: message.id })
            const row = messageRow(threadId, message.id, message.created_at, message, {
              attachments:
                message.attachments == null ? null : yield* json("the message attachments", message.attachments),
              metadata: yield* json("the message metadata", message.metadata ?? {}),
            })
            yield* sql`INSERT INTO messages ${sql.insert(row)}`
            return toMessage(row)
          }),
        ),

      getMessages: (threadId, options = {}) =>
        Effect.gen(function* () {
          const { limit, offset = 0, order = "desc", includeSilent = false, maxDepth } = options
          if (limit !== undefined && !isCount(limit))
            return yield* new InvalidMessagesQuery({ option: "limit", value: limit })
          if (!isCount(offset)) return yield* new InvalidMessagesQuery({ option: "offset", value: offset })
          if (maxDepth !== undefined && !isCount(maxDepth))
            return yield* new InvalidMessagesQuery({ option: "maxDepth", value: maxDepth })
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
        }).pipe(
          sql.withTransaction,
          // The client's BEGIN IMMEDIATE would block writers. A deferred BEGIN gives both reads one snapshot without it.
          Effect.provideService(BeginTransaction, "BEGIN"),
        ),

      getMessage: (threadId, messageId) =>
        Effect.map(selectMessages(sql.and([sql`thread_id = ${threadId}`, sql`id = ${messageId}`])), (rows) =>
          rows[0] === undefined ? null : toMessage(rows[0]),
        ),

      messageIdTaken: (messageId) =>
        Effect.map(sql`SELECT 1 FROM messages WHERE id = ${messageId}`, (rows) => rows.length > 0),

      updateMessage: (threadId, messageId, updates) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const where = sql.and([sql`thread_id = ${threadId}`, sql`id = ${messageId}`])
            const current = yield* first(
              yield* selectMessages(where),
              () => new MessageNotFound({ threadId, messageId }),
            )
            const changes = {
              ...(updates.content === undefined ? {} : { content: stored(updates.content) }),
              ...(updates.metadata === undefined
                ? {}
                : {
                    metadata: yield* json(
                      "the message metadata",
                      yield* json("the message metadata", updates.metadata).pipe(
                        Effect.map((patch) => ({ ...JSON.parse(current.metadata), ...JSON.parse(patch) })),
                      ),
                    ),
                  }),
            }
            if (Object.keys(changes).length > 0) yield* sql`UPDATE messages SET ${sql.update(changes)} WHERE ${where}`
            const updated = yield* selectMessages(where)
            return toMessage(yield* first(updated, () => new MessageNotFound({ threadId, messageId })))
          }),
        ),

      deleteMessage: (threadId, messageId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const deleted = yield* sql<MessageRow & { seq: number }>`
              DELETE FROM messages WHERE thread_id = ${threadId} AND id = ${messageId}
              RETURNING seq, ${sql.literal(messageColumns)}`
            if (deleted[0] === undefined) return false
            const parent = { ...toMessage(deleted[0]), seq: deleted[0].seq }
            // A message owns the results of the calls it lists, whatever its role, because a side B model
            // turn is stored as user. A provider may reuse a call id in a later turn or under another parent
            // message, so a result belongs to the nearest earlier message with the same parent that lists its id.
            if (parent.tool_calls !== null)
              yield* sql`
                DELETE FROM messages AS result WHERE thread_id = ${threadId} AND role = 'tool' AND seq > ${parent.seq}
                AND parent_id IS ${parent.parent_id}
                AND tool_call_id IN (SELECT CASE WHEN type = 'object' THEN json_extract(value, '$.id') END FROM json_each(
                  CASE WHEN json_valid(${parent.tool_calls}) THEN ${parent.tool_calls} ELSE '[]' END))
                AND NOT EXISTS (
                  SELECT 1 FROM messages AS later,
                    json_each(CASE WHEN json_valid(later.tool_calls) THEN later.tool_calls ELSE '[]' END)
                  WHERE later.thread_id = result.thread_id AND later.tool_calls IS NOT NULL
                  AND later.parent_id IS result.parent_id
                  AND later.seq > ${parent.seq} AND later.seq < result.seq
                  AND CASE WHEN json_each.type = 'object' THEN json_extract(json_each.value, '$.id') END = result.tool_call_id)`
            return true
          }),
        ),

      enqueue: (threadId, entry) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId)
            const payload = yield* json("the queue entry", queuePayload(entry))
            const queuedAt = yield* nowMicros
            const rows = yield* sql<QueueRow>`
              INSERT INTO queue ${sql.insert({ thread_id: threadId, kind: entry.kind, payload, queued_at: queuedAt })}
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
        isWellFormed(key)
          ? Effect.map(
              sql<{ value: string }>`SELECT value FROM kv WHERE thread_id = ${threadId} AND key = ${key}`,
              (rows) => (rows[0] === undefined ? null : JSON.parse(rows[0].value)),
            )
          : Effect.fail(new KeyNotWellFormed({ key })),

      setValue: (threadId, key, value) => {
        if (!isWellFormed(key)) return Effect.fail(new KeyNotWellFormed({ key }))
        if (value === null || value === undefined)
          return sql.withTransaction(
            Effect.gen(function* () {
              yield* requireThread(threadId)
              yield* sql`DELETE FROM kv WHERE thread_id = ${threadId} AND key = ${key}`
            }),
          )
        return sql.withTransaction(
          Effect.gen(function* () {
            const text = yield* json(`the value of key ${JSON.stringify(key)}`, value)
            yield* requireThread(threadId)
            yield* sql`
              INSERT INTO kv ${sql.insert({ thread_id: threadId, key, value: text })}
              ON CONFLICT (thread_id, key) DO UPDATE SET value = excluded.value`
          }),
        )
      },
    })
  }),
)
