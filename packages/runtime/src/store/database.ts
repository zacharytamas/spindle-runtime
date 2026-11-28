import { Clock, Effect, Scheduler } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { toJson } from "./json.ts"
import {
  FlowEnded,
  HandleExpired,
  originFlow,
  ThreadNotFound,
  ThreadTerminated,
  ValueNotJson,
  type WriteOrigin,
} from "./model.ts"
import { callsIn, type MessageRow, type QueueRow, runReasonColumn, type ThreadRow, text } from "./schema.ts"

export type RunRow = Pick<ThreadRow, "run_state" | "run_since" | "run_reason"> & {
  readonly flow_id: string | null
  readonly revision: number
  readonly terminated_at: number | null
}

export const runColumns = `run_state, run_since, ${runReasonColumn}, flow_id, terminated_at, revision`

// A synchronous queueTool call must find the shared connection free between fiber turns.
export const unyielding = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, Scheduler.PreventSchedulerYield, true)

export const nowMicros = Effect.map(Clock.currentTimeNanos, (nanos) => Number(nanos / 1000n))

export const json = (field: string, value: unknown): Effect.Effect<string, ValueNotJson> =>
  Effect.suspend(() => {
    const text = toJson(value)
    return typeof text === "string" ? Effect.succeed(text) : Effect.fail(new ValueNotJson({ field, ...text }))
  })

export const first = <A, E>(rows: ReadonlyArray<A>, missing: () => E): Effect.Effect<A, E> =>
  rows[0] === undefined ? Effect.fail(missing()) : Effect.succeed(rows[0])

export const authorize = (
  threadId: string,
  row: { flow_id: string | null; terminated_at: number | null },
  origin: WriteOrigin,
  operation?: "insert",
) => {
  const flowId = originFlow(origin)
  if (flowId !== null && row.flow_id !== flowId)
    return new FlowEnded({
      threadId,
      flowId,
      why: row.terminated_at === null ? "superseded" : "terminated",
    })
  if (origin.kind === "handle" && origin.expired()) return new HandleExpired()
  if (
    row.terminated_at !== null &&
    !(operation === "insert" && origin.kind === "handle" && origin.terminated === row.terminated_at)
  )
    return new ThreadTerminated({ threadId, terminated: row.terminated_at })
}
export const requireThread = <A>(threadId: string, rows: ReadonlyArray<A>) =>
  first(rows, () => new ThreadNotFound({ threadId }))

export const pending = (sql: SqlClient, threadId: string) => sql`disposition = 'pending' AND thread_id = ${threadId}`
export const queueHead = (sql: SqlClient, threadId: string) =>
  sql<QueueRow>`SELECT seq, kind, payload, queued_at FROM queue WHERE ${pending(sql, threadId)} ORDER BY seq LIMIT 1`

export const database = (sql: SqlClient) => {
  const threadRows = <A extends object>(threadId: string, columns: string) =>
    sql<A>`SELECT ${sql.literal(columns)} FROM threads WHERE id = ${threadId}`
  const runRows = (threadId: string) => threadRows<RunRow>(threadId, runColumns)
  const selectRun = (threadId: string) => Effect.flatMap(runRows(threadId), (rows) => requireThread(threadId, rows))
  // Node truncates TEXT at a NUL. Compare the complete stored identifiers on both drivers.
  const openCalls = (caller: { seq: number; tool_calls: MessageRow["tool_calls"] }) =>
    Effect.gen(function* () {
      const answered = yield* sql<{
        id: Uint8Array
      }>`SELECT CAST(tool_call_id AS BLOB) AS id FROM messages WHERE caller_seq = ${caller.seq}`
      const ids = new Set(answered.map((row) => text(row.id)))
      return callsIn(caller.tool_calls ?? "[]").filter((call) => !ids.has(call.id))
    })
  const deliveryCursor = (side: "a" | "b") => sql(side === "a" ? "side_a_delivered_seq" : "side_b_delivered_seq")
  return { deliveryCursor, sql, threadRows, runRows, selectRun, openCalls }
}
export type Database = ReturnType<typeof database>
