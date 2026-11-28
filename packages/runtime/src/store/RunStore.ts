import type { ThreadStatus } from "@standardagents/spec"
import { Context, Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { processAlive, processId } from "#platform"
import { CLOSING, transition } from "../execution/run-status.ts"
import {
  authorize,
  type Database,
  json,
  nowMicros,
  pending,
  queueHead,
  type RunRow,
  requireThread,
  runColumns,
  unyielding,
} from "./database.ts"
import {
  type Claim,
  external,
  FlowEnded,
  type Holder,
  type QueueEntry,
  type Thread,
  type ThreadNotFound,
  type WriteOrigin,
} from "./model.ts"
import {
  decodeQueued,
  type MessageRow,
  messageRow,
  type QueueRow,
  queuePayload,
  stored,
  type ThreadRow,
  text,
  threadColumns,
  toStatus,
  toThread,
} from "./schema.ts"

type Recovery =
  | { readonly kind: "atRest"; readonly thread: Thread }
  | { readonly kind: "missingHolder"; readonly thread: Thread }
  | { readonly kind: "alive" | "recovered"; readonly thread: Thread; readonly pid: number }

// All connections in this process can observe claims held by its supervisors.
const localHolders = new Set<string>()

const sessionEnds = new Set([
  "max_session_turns",
  "state_stop_session",
  "session_stop",
  "session_fail",
  "step_error",
  "fatal_error",
  "execution_lost",
])

export const makeRunStore = ({ sql, selectRun, runRows, openCalls }: Database) => {
  const hasPending = (threadId: string) =>
    Effect.map(sql`SELECT 1 FROM queue WHERE ${pending(sql, threadId)} LIMIT 1`, (rows) => rows.length > 0)
  const queueDisposition = Effect.fn("RunStore.queueDisposition")(function* (threadId: string, seq: number) {
    const [row] = yield* sql<{ disposition: "pending" | "failed_delivery" }>`
        SELECT disposition FROM queue WHERE thread_id = ${threadId} AND seq = ${seq}
        UNION ALL SELECT 'failed_delivery' FROM waiting_senders WHERE thread_id = ${threadId} AND seq = ${seq} AND failed = 1
        LIMIT 1`
    return row?.disposition
  }, unyielding)
  const closeCalls = (threadId: string, flowId: string | null, closing: string, now: number) =>
    Effect.gen(function* () {
      const callers = yield* sql<Pick<MessageRow, "tool_calls" | "parent_id" | "prompt"> & { seq: number }>`
          SELECT seq, tool_calls, CAST(parent_id AS BLOB) AS parent_id, CAST(coalesce(result_prompt, prompt) AS BLOB) AS prompt FROM messages
          WHERE thread_id = ${threadId} AND flow_id = ${flowId} AND tool_calls IS NOT NULL
          ORDER BY seq`
      for (const caller of callers) {
        for (const call of yield* openCalls(caller))
          yield* sql`INSERT INTO messages ${sql.insert({
            flow_id: flowId,
            caller_seq: caller.seq,
            ...messageRow(
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
                prompt: text(caller.prompt),
                parent_id: text(caller.parent_id),
              },
              { attachments: null, metadata: "{}" },
            ),
          })}`
      }
    })

  // Execution State section 4.3: a run starts from idle or failed.
  const claimRun = (threadId: string, row: RunRow, claim: Claim, now: number) =>
    Effect.gen(function* () {
      const next = transition(toStatus(row), { type: "start" }, now)
      if (next === undefined) return false
      yield* sql`UPDATE threads SET run_state = ${next.state}, run_reason = NULL, run_since = ${next.since},
          holder_id = ${claim.holder}, flow_id = ${claim.flowId}
          WHERE id = ${threadId}`
      return true
    })

  const release = (threadId: string, status: ThreadStatus) =>
    sql`UPDATE threads SET run_state = ${status.state}, run_reason = ${stored(status.reason ?? null)},
        session_turns = ${status.reason && sessionEnds.has(status.reason) ? 0 : sql.literal("session_turns")},
        run_since = ${status.since}, holder_id = NULL, flow_id = NULL WHERE id = ${threadId}`

  const settleWith = (threadId: string, row: RunRow, event: Parameters<typeof transition>[1], closing: string) =>
    Effect.gen(function* () {
      const now = yield* nowMicros
      yield* closeCalls(threadId, row.flow_id, closing, now)
      const next = transition(toStatus(row), event, now)
      if (next === undefined)
        return yield* Effect.die(new Error(`run status ${row.run_state} cannot take ${event.type}`))
      yield* release(threadId, next)
      return next
    })

  type HolderRow = { holder_id: string | null; pid: number | null }
  const running = sql`run_state = 'running'`
  const heldRows = <A extends object>(columns: string, where: ReturnType<typeof sql.and>) => sql<A & HolderRow>`
    SELECT t.*, h.pid FROM (SELECT ${sql.literal(columns)}, holder_id FROM threads WHERE ${where}) t
    LEFT JOIN holders h ON h.id = t.holder_id`
  const lost = ({ pid, holder_id }: HolderRow) =>
    pid === null || pid <= 0 || (pid === processId && (holder_id === null || !localHolders.has(holder_id)))
      ? Effect.succeed(true)
      : Effect.map(processAlive(pid), (alive) => !alive)

  const unclaimed = sql`NOT EXISTS (SELECT 1 FROM threads WHERE ${running} AND holder_id = holders.id)`
  const removeUnclaimed = (row: HolderRow) =>
    sql`DELETE FROM holders WHERE id = ${row.holder_id} AND pid = ${row.pid} AND ${unclaimed}`.pipe(
      // A constraint can keep the row. Recovery must still release the thread, and the poll can retry deletion.
      Effect.catchIf(
        (error) => error.reason._tag === "ConstraintError",
        () => Effect.void,
      ),
    )

  const settleLost = (threadId: string, row: RunRow & HolderRow, dead: boolean) =>
    Effect.gen(function* () {
      const status = yield* settleWith(threadId, row, { type: "lose" }, CLOSING.lost)
      if (dead && row.holder_id !== null) yield* removeUnclaimed(row)
      return status
    })

  return {
    terminate: Effect.fn("RunStore.terminate")(
      function* (threadId: string, origin: WriteOrigin) {
        const now = yield* nowMicros
        const run = yield* selectRun(threadId)
        if (run.terminated_at !== null) return run.terminated_at
        const refusal = authorize(threadId, run, origin)
        if (refusal) return yield* refusal
        yield* sql`UPDATE threads SET terminated_at = ${now} WHERE id = ${threadId}`
        if (run.run_state === "running")
          yield* settleWith(threadId, run, { type: "settle", state: "idle", reason: "aborted" }, CLOSING.terminated)
        return now
      },
      sql.withTransaction,
      unyielding,
    ),

    admit: Effect.fn("RunStore.admit")(
      function* (threadId: string, entry: QueueEntry, claim: Claim, origin: WriteOrigin, waitForDelivery = false) {
        const row = yield* selectRun(threadId)
        const refusal = authorize(threadId, row, origin)
        if (refusal) return yield* refusal
        const payload = yield* json("the queue entry", queuePayload(entry))
        const now = yield* nowMicros
        const rows = yield* sql<QueueRow>`
              INSERT INTO queue ${sql.insert({ thread_id: threadId, kind: entry.kind, payload, queued_at: now })}
              RETURNING seq, kind, payload, queued_at`
        const queued = decodeQueued(yield* requireThread(threadId, rows))
        if (!queued) return yield* Effect.die(new Error("Invalid queued payload"))
        if (waitForDelivery)
          yield* sql`INSERT INTO waiting_senders (seq, thread_id, holder_id) VALUES (${queued.seq}, ${threadId}, ${claim.holder})`
        return { queued, claimed: yield* claimRun(threadId, row, claim, now) }
      },
      sql.withTransaction,
      unyielding,
    ),

    claim: Effect.fn("RunStore.claim")(
      function* (threadId: string, claim: Claim) {
        const [row] = yield* runRows(threadId)
        if (row === undefined || row.terminated_at !== null) return false
        return (yield* hasPending(threadId)) && (yield* claimRun(threadId, row, claim, yield* nowMicros))
      },
      sql.withTransaction,
      unyielding,
    ),

    completeTurn: Effect.fn("RunStore.completeTurn")(function* (threadId: string, flowId: string) {
      const [updated] = yield* sql<{ session_turns: number }>`UPDATE threads SET session_turns = session_turns + 1
        WHERE id = ${threadId} AND flow_id = ${flowId} AND run_state = 'running' RETURNING session_turns`
      if (updated) return updated.session_turns
      const row = yield* selectRun(threadId)
      return yield* new FlowEnded({ threadId, flowId, why: row.terminated_at === null ? "superseded" : "terminated" })
    }, unyielding),

    queueDisposition,
    releaseSender: Effect.fn("RunStore.releaseSender")(
      (seq: number, holder: string) => sql`DELETE FROM waiting_senders WHERE seq = ${seq} AND holder_id = ${holder}`,
      unyielding,
    ),
    isQueued: (threadId: string, seq: number) =>
      Effect.map(queueDisposition(threadId, seq), (disposition) => disposition === "pending"),

    failedDeliveries: Effect.fn("RunStore.failedDeliveries")(
      (threadId: string) => sql<Pick<QueueRow, "kind" | "queued_at"> & { seq: string }>`
        SELECT CAST(seq AS TEXT) AS seq, kind, queued_at FROM queue WHERE thread_id = ${threadId} AND disposition = 'failed_delivery'
        ORDER BY queue.seq`,
      unyielding,
    ),

    discardFailed: Effect.fn("RunStore.discardFailed")(
      function* (threadId: string, seq: string) {
        const refusal = authorize(threadId, yield* selectRun(threadId), external)
        if (refusal) return yield* refusal
        const [removed] = yield* sql<Pick<QueueRow, "kind">>`
          DELETE FROM queue WHERE thread_id = ${threadId} AND seq = ${seq} AND disposition = 'failed_delivery'
          RETURNING kind`
        return removed?.kind
      },
      sql.withTransaction,
      unyielding,
    ),

    nextQueued: Effect.fn("RunStore.nextQueued")(function* (threadId: string, origin: { readonly flowId: string }) {
      while (true) {
        const [row] = yield* queueHead(sql, threadId)
        if (!row) return undefined
        const entry = decodeQueued(row)
        if (entry) return entry
        const changed = yield* sql.withTransaction(
          Effect.gen(function* () {
            const [run] = yield* runRows(threadId)
            if (!run || run.flow_id !== origin.flowId) return []
            const marked =
              yield* sql`UPDATE queue SET disposition = 'failed_delivery' WHERE ${pending(sql, threadId)} AND seq = ${row.seq} RETURNING seq`
            if (marked.length) yield* sql`UPDATE waiting_senders SET failed = 1 WHERE seq = ${row.seq}`
            return marked
          }),
        )
        if (!changed.length) return undefined
      }
    }, unyielding),

    queueLength: Effect.fn("RunStore.queueLength")(
      (threadId: string) =>
        Effect.map(
          sql<{
            count: number
          }>`SELECT count(*) AS count FROM queue WHERE ${pending(sql, threadId)}`,
          (rows) => rows[0]?.count ?? 0,
        ),
      unyielding,
    ),

    settle: Effect.fn("RunStore.settle")(
      function* (
        threadId: string,
        origin: { readonly flowId: string },
        outcome: { readonly state: "idle" | "failed"; readonly reason: string },
        options: {
          readonly continueIfQueued: boolean
          readonly settleOnly?: boolean
          readonly atCap?: boolean
          readonly closing: string
        },
      ) {
        const [row] = yield* runRows(threadId)
        if (row === undefined || row.flow_id !== origin.flowId || row.run_state !== "running")
          return row?.terminated_at != null ? ("terminated" as const) : ("superseded" as const)
        // The check and the release share one transaction, so work queued after the last drain either keeps this
        // run going or finds the thread released and starts the next one.
        if (options.continueIfQueued && row.terminated_at === null) {
          if ((options.atCap || !options.settleOnly) && (yield* hasPending(threadId))) {
            if (!options.atCap) return "continue" as const
            yield* settleWith(
              threadId,
              row,
              { type: "settle", state: "idle", reason: "max_total_steps" },
              options.closing,
            )
            return "capped" as const
          }
        }
        yield* settleWith(threadId, row, { type: "settle", ...outcome }, options.closing)
        return "settled" as const
      },
      sql.withTransaction,
      unyielding,
    ),

    recoverLost: (threadId?: string) =>
      Effect.gen(function* () {
        const candidates = heldRows<RunRow & { id: string }>(
          `id, ${runColumns}`,
          sql.and([running, ...(threadId === undefined ? [] : [sql`id = ${threadId}`])]),
        )
        const ids = new Set<string | null>()
        for (const row of yield* candidates) if (yield* lost(row)) ids.add(row.flow_id)
        if (!ids.size) return []
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const recovered = []
            for (const row of yield* candidates) {
              if (!ids.has(row.flow_id) || !(yield* lost(row))) continue
              yield* settleLost(row.id, row, true)
              recovered.push(row.id)
            }
            return recovered
          }),
        )
      }).pipe(Effect.withSpan("RunStore.recoverLost"), unyielding),

    recoverThread: Effect.fn("RunStore.recoverThread")(
      function* (threadId: string, force: boolean): Effect.fn.Return<Recovery, ThreadNotFound | SqlError> {
        const row = yield* requireThread(
          threadId,
          yield* heldRows<ThreadRow & RunRow>(`${threadColumns}, flow_id, revision`, sql`id = ${threadId}`),
        )
        const thread = toThread(row)
        if (row.run_state !== "running") return { kind: "atRest", thread }
        const dead = yield* lost(row)
        if (!dead && row.pid !== null && !force) return { kind: "alive", thread, pid: row.pid }
        const status = yield* settleLost(threadId, row, dead)
        const settled = { ...thread, status }
        return row.pid === null
          ? { kind: "missingHolder", thread: settled }
          : { kind: "recovered", thread: settled, pid: row.pid }
      },
      sql.withTransaction,
      unyielding,
    ),

    pruneHolders: Effect.fn("RunStore.pruneHolders")(function* () {
      const rows = yield* sql<HolderRow>`SELECT id AS holder_id, pid FROM holders WHERE ${unclaimed}`
      for (const row of rows) {
        if (yield* lost(row))
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (yield* lost(row)) yield* removeUnclaimed(row)
            }),
          )
      }
    }, unyielding),

    acquireHolder: Effect.fn("RunStore.acquireHolder")(
      (holder: Holder) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            yield* sql`INSERT INTO holders ${sql.insert({ ...holder })}`
            if (holder.pid === processId) localHolders.add(holder.id)
          }),
          () =>
            Effect.gen(function* () {
              yield* Effect.ignore(sql`DELETE FROM holders WHERE id = ${holder.id}`)
              if (holder.pid === processId) localHolders.delete(holder.id)
            }),
        ),
      unyielding,
    ),

    holderOf: Effect.fn("RunStore.holderOf")(function* (threadId: string) {
      const [holder] = yield* sql<Holder>`SELECT h.id, h.pid FROM threads t JOIN holders h ON h.id = t.holder_id
        WHERE t.id = ${threadId} AND ${running}`
      return holder ?? null
    }, unyielding),

    owned: Effect.fn("RunStore.owned")(
      (holderId: string) =>
        Effect.map(
          sql<{ id: string; flow_id: string }>`
            SELECT id, flow_id FROM threads WHERE ${running} AND holder_id = ${holderId}`,
          (rows) => new Map(rows.map((row) => [row.id, row.flow_id])),
        ),
      unyielding,
    ),
  }
}

export class RunStore extends Context.Service<RunStore, ReturnType<typeof makeRunStore>>()("spindle/RunStore") {}
