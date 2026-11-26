import type { ThreadStatus } from "@standardagents/spec"
import { Clock, Effect, Layer, Option, Scheduler } from "effect"
import * as Migrator from "effect/sql/Migrator"
import { BeginTransaction, SqlClient } from "effect/sql/SqlClient"
import { CLOSING, transition } from "../execution/run-status.ts"
import threads from "./migrations/0001_threads.ts"
import revisions from "./migrations/0002_revision.ts"
import claims from "./migrations/0003_claims.ts"
import {
  callsIn,
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
  FlowEnded,
  InvalidMessagesQuery,
  KeyNotWellFormed,
  MessageIdTaken,
  MessageNotFound,
  QueueEntryGone,
  type ThreadHistory,
  ThreadNotFound,
  ThreadStore,
  ThreadTerminated,
  ValueNotJson,
} from "./ThreadStore.ts"

const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({ "0001_threads": threads, "0002_revision": revisions, "0003_claims": claims }),
})

type RunRow = Pick<ThreadRow, "run_state" | "run_since" | "run_reason"> & {
  readonly flow_id: string | null
  readonly claim_seq: number | null
  readonly terminated_at: number | null
}

const runColumns = `run_state, run_since, ${runReasonColumn}, flow_id, claim_seq, terminated_at`

// A store call never yields to another fiber while it holds the one connection. Code outside Effect, such as a tool
// that calls queueTool, runs only between fibers, so it always finds the connection free and its synchronous call
// completes before it returns.
const unyielding = <S extends object>(service: S): S =>
  Object.fromEntries(
    Object.entries(service).map(([key, member]) => [
      key,
      typeof member === "function"
        ? (...args: ReadonlyArray<unknown>) =>
            Effect.provideService(member(...args), Scheduler.PreventSchedulerYield, true)
        : member,
    ]),
  ) as S

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

    const selectRun = (threadId: string) =>
      Effect.flatMap(sql<RunRow>`SELECT ${sql.literal(runColumns)} FROM threads WHERE id = ${threadId}`, (rows) =>
        first(rows, () => new ThreadNotFound({ threadId })),
      )

    // Every call that the run stored with no result after it gets an error result, so that each call the next request
    // shows has its result. A result belongs to a later tool message with the same parent and call id.
    const closeCalls = (threadId: string, claimSeq: number, closing: string, now: number) =>
      Effect.gen(function* () {
        const callers = yield* sql<Pick<MessageRow, "tool_calls" | "parent_id" | "prompt"> & { seq: number }>`
          SELECT seq, tool_calls, parent_id, prompt FROM messages
          WHERE thread_id = ${threadId} AND seq > ${claimSeq} AND tool_calls IS NOT NULL AND prompt IS NOT NULL
          ORDER BY seq`
        for (const caller of callers) {
          const answered = yield* sql<{ tool_call_id: string }>`
            SELECT tool_call_id FROM messages WHERE thread_id = ${threadId} AND role = 'tool' AND seq > ${caller.seq}
            AND parent_id IS ${caller.parent_id}`
          const ids = new Set(answered.map((row) => row.tool_call_id))
          for (const call of callsIn(caller.tool_calls ?? "[]"))
            if (!ids.has(call.id))
              yield* sql`INSERT INTO messages ${sql.insert(
                messageRow(
                  threadId,
                  crypto.randomUUID(),
                  now,
                  {
                    role: "tool",
                    name: call.name,
                    tool_call_id: call.id,
                    tool_status: "error",
                    status: "completed",
                    content: closing,
                    prompt: typeof caller.prompt === "string" ? caller.prompt : null,
                    parent_id: typeof caller.parent_id === "string" ? caller.parent_id : null,
                  },
                  { attachments: null, metadata: "{}" },
                ),
              )}`
        }
      })

    const release = (threadId: string, status: ThreadStatus) =>
      sql`UPDATE threads SET run_state = ${status.state}, run_reason = ${stored(status.reason ?? null)},
        run_since = ${status.since}, holder_id = NULL, flow_id = NULL, claim_seq = NULL WHERE id = ${threadId}`

    const settleWith = (threadId: string, row: RunRow, event: Parameters<typeof transition>[1], closing: string) =>
      Effect.gen(function* () {
        const now = yield* nowMicros
        yield* closeCalls(threadId, row.claim_seq ?? 0, closing, now)
        const next = transition(toStatus(row), event, now)
        if (next === undefined)
          return yield* Effect.die(new Error(`run status ${row.run_state} cannot take ${event.type}`))
        yield* release(threadId, next)
      })

    const store = ThreadStore.of({
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

      // Runtime section 10: the first termination time stays. A running run settles idle with aborted in the same
      // transaction, so the execution that ran it can write nothing more.
      terminate: (threadId) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const now = yield* nowMicros
            const rows = yield* sql<{ terminated_at: number }>`
              UPDATE threads SET terminated_at = coalesce(terminated_at, ${now})
              WHERE id = ${threadId} RETURNING terminated_at`
            const row = yield* first(rows, () => new ThreadNotFound({ threadId }))
            const run = yield* selectRun(threadId)
            if (run.run_state === "running")
              yield* settleWith(threadId, run, { type: "settle", state: "idle", reason: "aborted" }, CLOSING.terminated)
            return row.terminated_at
          }),
        ),

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

      insertMessage: (threadId, message, options = {}) =>
        Effect.gen(function* () {
          const nested = Option.isSome(yield* Effect.serviceOption(sql.transactionService))
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const thread = yield* first(
                yield* sql<{ revision: number; flow_id: string | null; terminated_at: number | null }>`
                  SELECT revision, flow_id, terminated_at FROM threads WHERE id = ${threadId}`,
                () => new ThreadNotFound({ threadId }),
              )
              const { flowId, dequeue } = options
              if (flowId !== undefined && thread.flow_id !== flowId)
                return yield* new FlowEnded({
                  threadId,
                  flowId,
                  why: thread.terminated_at === null ? "superseded" : "terminated",
                })
              if (dequeue !== undefined) {
                const removed =
                  yield* sql`DELETE FROM queue WHERE thread_id = ${threadId} AND seq = ${dequeue} RETURNING seq`
                if (removed.length === 0) return yield* new QueueEntryGone({ seq: dequeue })
              }
              // Message ids are unique across threads, so an id that another thread holds is taken too.
              const taken = yield* sql`SELECT 1 FROM messages WHERE id = ${message.id}`
              if (taken.length > 0) return yield* new MessageIdTaken({ messageId: message.id })
              const row = messageRow(threadId, message.id, message.created_at, message, {
                attachments:
                  message.attachments == null ? null : yield* json("the message attachments", message.attachments),
                metadata: yield* json("the message metadata", message.metadata ?? {}),
              })
              yield* sql`INSERT INTO messages ${sql.insert(row)}`
              // The insert trigger added one, and BEGIN IMMEDIATE kept every other writer out since the read.
              return { message: toMessage(row), revision: nested ? null : thread.revision + 1 }
            }),
          )
        }),

      revision: (threadId) =>
        Effect.flatMap(sql<{ revision: number }>`SELECT revision FROM threads WHERE id = ${threadId}`, (rows) =>
          Effect.map(
            first(rows, () => new ThreadNotFound({ threadId })),
            (row) => row.revision,
          ),
        ),

      history: (threadId) =>
        Effect.gen(function* () {
          const thread = yield* first(
            yield* sql<{ revision: number }>`SELECT revision FROM threads WHERE id = ${threadId}`,
            () => new ThreadNotFound({ threadId }),
          )
          const rows = yield* sql<MessageRow>`${selectMessages(sql.and([sql`thread_id = ${threadId}`]))} ORDER BY seq`
          return { revision: thread.revision, messages: rows.map(toMessage) }
        }).pipe(sql.withTransaction, Effect.provideService(BeginTransaction, "BEGIN"), (read) =>
          Effect.flatMap(Effect.serviceOption(sql.transactionService), (outer) =>
            Effect.map(
              read,
              (history): ThreadHistory => (Option.isSome(outer) ? { ...history, revision: null } : history),
            ),
          ),
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

      admit: (threadId, entry, claim) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const row = yield* selectRun(threadId)
            if (row.terminated_at !== null)
              return yield* new ThreadTerminated({ threadId, terminated: row.terminated_at })
            const payload = yield* json("the queue entry", queuePayload(entry))
            const now = yield* nowMicros
            const rows = yield* sql<QueueRow>`
              INSERT INTO queue ${sql.insert({ thread_id: threadId, kind: entry.kind, payload, queued_at: now })}
              RETURNING seq, kind, payload, queued_at`
            const queued = toQueued(yield* first(rows, () => new ThreadNotFound({ threadId })))
            const next = transition(toStatus(row), { type: "start" }, now)
            if (next === undefined) return { queued, claimed: false }
            const [last] = yield* sql<{ seq: number }>`
              SELECT coalesce(max(seq), 0) AS seq FROM messages WHERE thread_id = ${threadId}`
            yield* sql`UPDATE threads SET run_state = ${next.state}, run_reason = NULL, run_since = ${next.since},
              holder_id = ${claim.holder}, flow_id = ${claim.flowId}, claim_seq = ${last?.seq ?? 0}
              WHERE id = ${threadId}`
            return { queued, claimed: true }
          }),
        ),

      nextQueued: (threadId) =>
        Effect.map(
          sql<QueueRow>`
            SELECT seq, kind, payload, queued_at FROM queue WHERE thread_id = ${threadId} ORDER BY seq LIMIT 1`,
          (rows) => (rows[0] === undefined ? undefined : toQueued(rows[0])),
        ),

      queueLength: (threadId) =>
        Effect.map(
          sql<{ count: number }>`SELECT count(*) AS count FROM queue WHERE thread_id = ${threadId}`,
          (rows) => rows[0]?.count ?? 0,
        ),

      settle: (threadId, flowId, outcome, options) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const [row] = yield* sql<RunRow>`SELECT ${sql.literal(runColumns)} FROM threads WHERE id = ${threadId}`
            if (row === undefined || row.flow_id !== flowId || row.run_state !== "running") return "superseded"
            // The check and the release share one transaction, so work queued after the last drain either keeps this
            // run going or finds the thread released and starts the next one.
            if (options.continueIfQueued && row.terminated_at === null) {
              const head = yield* sql`SELECT 1 FROM queue WHERE thread_id = ${threadId} LIMIT 1`
              if (head.length > 0) return "continue"
            }
            yield* settleWith(threadId, row, { type: "settle", ...outcome }, options.closing)
            return "settled"
          }),
        ),

      recover: (threadId) =>
        Effect.gen(function* () {
          const now = yield* nowMicros
          const lost = sql<{ id: string }>`
            SELECT t.id FROM threads AS t LEFT JOIN holders AS h ON h.id = t.holder_id
            WHERE ${sql.and([
              sql`t.run_state = 'running'`,
              sql`(h.id IS NULL OR h.expires_at < ${now})`,
              ...(threadId === undefined ? [] : [sql`t.id = ${threadId}`]),
            ])}`
          // A read first, so that a status read of a live thread takes no write lock.
          if ((yield* lost).length === 0) return []
          return yield* sql.withTransaction(
            Effect.gen(function* () {
              const recovered: Array<string> = []
              for (const { id } of yield* lost) {
                yield* settleWith(id, yield* Effect.orDie(selectRun(id)), { type: "lose" }, CLOSING.lost)
                recovered.push(id)
              }
              return recovered
            }),
          )
        }),

      beat: (holder, leaseMicros) =>
        Effect.gen(function* () {
          const now = yield* nowMicros
          yield* sql`
            INSERT INTO holders ${sql.insert({ id: holder.id, pid: holder.pid, started_at: now, beat_at: now, expires_at: now + leaseMicros })}
            ON CONFLICT (id) DO UPDATE SET beat_at = excluded.beat_at, expires_at = excluded.expires_at`
        }),

      dropHolder: (holderId) => Effect.asVoid(sql`DELETE FROM holders WHERE id = ${holderId}`),

      holderOf: (threadId) =>
        Effect.map(
          sql<{ id: string; pid: number; beat_at: number; expires_at: number }>`
            SELECT h.id, h.pid, h.beat_at, h.expires_at FROM threads AS t JOIN holders AS h ON h.id = t.holder_id
            WHERE t.id = ${threadId} AND t.run_state = 'running'`,
          (rows) =>
            rows[0] === undefined
              ? null
              : { id: rows[0].id, pid: rows[0].pid, beatAt: rows[0].beat_at, expiresAt: rows[0].expires_at },
        ),

      owned: (holderId) =>
        Effect.map(
          sql<{ id: string; flow_id: string }>`
            SELECT id, flow_id FROM threads WHERE run_state = 'running' AND holder_id = ${holderId}`,
          (rows) => new Map(rows.map((row) => [row.id, row.flow_id])),
        ),
    })
    return unyielding(store)
  }),
)
