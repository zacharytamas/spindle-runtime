import type { GetMessagesOptions, MessageUpdates } from "@standardagents/spec"
import { Context, Effect, Option, Schema } from "effect"
import { BeginTransaction } from "effect/sql/SqlClient"
import { authorize, type Database, first, json, pending, unyielding } from "./database.ts"
import {
  CallerHasOpenCalls,
  type IdentifiedMessage,
  InvalidMessagesQuery,
  MessageIdTaken,
  MessageNotFound,
  originFlow,
  QueueEntryGone,
  type ThreadHistory,
  type WriteOrigin,
} from "./model.ts"
import { type MessageRow, messageColumns, messageRow, stored, toMessage } from "./schema.ts"

const isCount = Schema.is(Schema.Natural)

export const makeMessageStore = ({ sql, selectRun, runRows, openCalls }: Database) => {
  const messageIdTaken = (id: string) =>
    Effect.map(sql`SELECT 1 FROM messages WHERE id = ${id}`, (rows) => rows.length > 0)
  const revision = (threadId: string) => Effect.map(selectRun(threadId), (row) => row.revision)

  const guardWrite = (threadId: string, origin: WriteOrigin) =>
    Effect.gen(function* () {
      const [row] = yield* runRows(threadId)
      if (row) {
        const refusal = authorize(threadId, row, origin)
        if (refusal) return yield* refusal
      }
      return row
    })

  const selectMessages = (where: ReturnType<typeof sql.and>) =>
    sql<MessageRow>`SELECT ${sql.literal(messageColumns)} FROM messages WHERE ${where}`

  return {
    insertMessage: Effect.fn("MessageStore.insertMessage")(function* (
      threadId: string,
      message: IdentifiedMessage,
      origin: WriteOrigin,
      link: { readonly callerSeq?: number | undefined; readonly dequeue?: number | undefined } = {},
    ) {
      const nested = Option.isSome(yield* Effect.serviceOption(sql.transactionService))
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const thread = yield* selectRun(threadId)
          const flowId = originFlow(origin)
          const { callerSeq, dequeue } = flowId === null ? {} : link
          const refusal = authorize(threadId, thread, origin, "insert")
          if (refusal) return yield* refusal
          if (dequeue !== undefined) {
            const removed =
              yield* sql`DELETE FROM queue WHERE ${pending(sql, threadId)} AND seq = ${dequeue} RETURNING seq`
            if (removed.length === 0) return yield* new QueueEntryGone({ seq: dequeue })
          }
          // Message ids are unique across threads, so an id that another thread holds is taken too.
          if (yield* messageIdTaken(message.id)) return yield* new MessageIdTaken({ messageId: message.id })
          const row = messageRow(threadId, message.id, message.created_at, message, {
            attachments:
              message.attachments == null ? null : yield* json("the message attachments", message.attachments),
            metadata: yield* json("the message metadata", message.metadata ?? {}),
          })
          const facts = {
            admission_seq: dequeue ?? null,
            flow_id: flowId,
            caller_seq: callerSeq ?? null,
          }
          const [inserted] = yield* sql<{
            seq: number
          }>`INSERT INTO messages ${sql.insert({ ...row, ...facts })} RETURNING seq`
          if (!inserted) return yield* Effect.die("Message insert returned no sequence")
          // The insert trigger added one, and BEGIN IMMEDIATE kept every other writer out since the read.
          return {
            message: toMessage(row),
            seq: inserted.seq,
            callerSeq: facts.caller_seq,
            revision: nested ? null : thread.revision + 1,
          }
        }),
      )
    }, unyielding),

    history: Effect.fn("MessageStore.history")(
      (threadId: string) =>
        Effect.gen(function* () {
          const current = yield* revision(threadId)
          const rows = yield* sql<
            MessageRow & { seq: number; caller_seq: number | null }
          >`${selectMessages(sql.and([sql`thread_id = ${threadId}`]))} ORDER BY seq`
          return {
            revision: current,
            rows: rows.map((row) => ({ message: toMessage(row), seq: row.seq, callerSeq: row.caller_seq })),
          }
        }).pipe(sql.withTransaction, Effect.provideService(BeginTransaction, "BEGIN"), (read) =>
          Effect.zipWith(
            Effect.serviceOption(sql.transactionService),
            read,
            (outer, history): ThreadHistory => (Option.isSome(outer) ? { ...history, revision: null } : history),
          ),
        ),
      unyielding,
    ),

    latestMessageSeq: Effect.fn("MessageStore.latestMessageSeq")(
      (threadId: string) =>
        Effect.map(
          sql<{ latest: number }>`SELECT coalesce(max(seq), 0) AS latest FROM messages WHERE thread_id = ${threadId}`,
          (rows) => rows[0]?.latest ?? 0,
        ),
      unyielding,
    ),

    messagesAfter: Effect.fn("MessageStore.messagesAfter")(
      (threadId: string, seq: number) =>
        Effect.map(
          sql<MessageRow & { seq: number; admission_seq: number | null }>`
          SELECT ${sql.literal(messageColumns)}, admission_seq FROM messages
          WHERE thread_id = ${threadId} AND seq > ${seq} ORDER BY seq`,
          (rows) => rows.map((row) => ({ seq: row.seq, admission: row.admission_seq, message: toMessage(row) })),
        ),
      unyielding,
    ),

    getMessages: Effect.fn("MessageStore.getMessages")(
      (threadId: string, options: GetMessagesOptions = {}) =>
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
      unyielding,
    ),

    getMessage: Effect.fn("MessageStore.getMessage")(
      (threadId: string, messageId: string) =>
        Effect.map(selectMessages(sql.and([sql`thread_id = ${threadId}`, sql`id = ${messageId}`])), (rows) =>
          rows[0] === undefined ? null : toMessage(rows[0]),
        ),
      unyielding,
    ),

    updateMessage: Effect.fn("MessageStore.updateMessage")(
      function* (threadId: string, messageId: string, updates: MessageUpdates, origin: WriteOrigin) {
        yield* guardWrite(threadId, origin)
        const where = sql.and([sql`thread_id = ${threadId}`, sql`id = ${messageId}`])
        const current = yield* first(yield* selectMessages(where), () => new MessageNotFound({ threadId, messageId }))
        const changes: { content?: string | null; metadata?: string } = {}
        if (updates.content !== undefined) changes.content = stored(updates.content)
        if (updates.metadata !== undefined) {
          const patch = yield* json("the message metadata", updates.metadata)
          changes.metadata = yield* json("the message metadata", {
            ...JSON.parse(current.metadata),
            ...JSON.parse(patch),
          })
        }
        if (Object.keys(changes).length === 0) return toMessage(current)
        const updated =
          yield* sql<MessageRow>`UPDATE messages SET ${sql.update(changes)} WHERE ${where} RETURNING ${sql.literal(messageColumns)}`
        return toMessage(yield* first(updated, () => new MessageNotFound({ threadId, messageId })))
      },
      sql.withTransaction,
      unyielding,
    ),

    deleteMessage: Effect.fn("MessageStore.deleteMessage")(
      function* (threadId: string, messageId: string, origin: WriteOrigin) {
        const run = yield* guardWrite(threadId, origin)
        const [active] = yield* sql<{ seq: number; tool_calls: string }>`
              SELECT seq,tool_calls FROM messages WHERE thread_id = ${threadId} AND id = ${messageId} AND flow_id = ${run?.flow_id ?? null} AND tool_calls IS NOT NULL`
        if (active && (yield* openCalls(active)).length) return yield* new CallerHasOpenCalls({ messageId })
        const deleted = yield* sql<MessageRow & { seq: number }>`
              DELETE FROM messages WHERE thread_id = ${threadId} AND id = ${messageId}
              RETURNING ${sql.literal(messageColumns)}`
        if (deleted[0] === undefined) return false
        const parent = { ...toMessage(deleted[0]), seq: deleted[0].seq }
        // A message owns the results of the calls it lists, whatever its role, because a side B model
        // turn is stored as user. A provider may reuse a call id in a later turn or under another parent
        // message, so a result belongs to the nearest earlier message with the same parent that lists its id.
        if (parent.tool_calls !== null) {
          yield* sql`DELETE FROM messages WHERE caller_seq = ${parent.seq}`
          yield* sql`
                DELETE FROM messages AS result WHERE caller_seq IS NULL AND flow_id IS NULL AND thread_id = ${threadId} AND role = 'tool' AND seq > ${parent.seq}
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
        }
        return true
      },
      sql.withTransaction,
      unyielding,
    ),

    revision: Effect.fn("MessageStore.revision")(revision, unyielding),

    messageIdTaken: Effect.fn("MessageStore.messageIdTaken")(messageIdTaken, unyielding),
  }
}

export class MessageStore extends Context.Service<MessageStore, ReturnType<typeof makeMessageStore>>()(
  "spindle/MessageStore",
) {}
