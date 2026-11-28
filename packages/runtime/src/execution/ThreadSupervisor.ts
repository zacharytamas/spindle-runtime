import type { QueueMessageInput, ThreadStatus } from "@standardagents/spec"
import { Context, Data, Duration, Effect, Layer, Scope } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { processId } from "#platform"
import type { Registry } from "../registry/Registry.ts"
import {
  external,
  originFlow,
  type QueueEntry,
  type ThreadNotFound,
  ThreadTerminated,
  type WriteOrigin,
} from "../store/model.ts"
import { RunStore } from "../store/RunStore.ts"
import type { Stores } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import { Execution } from "./Execution.ts"
import { CLOSING } from "./run-status.ts"
import { type ExecutionOptions, prepareSteps, type RunOutcome } from "./step.ts"
import { type AdmissionError, queuedMessage, type ThreadControl } from "./thread-state.ts"
import { loadAgent, roleOf, type SetupError, senderSide } from "./turn.ts"

const CONTROL_POLL = Duration.millis(250)

class InvalidOption extends Data.TaggedError("InvalidOption")<{ readonly message: string }> {}

export interface Delivery {
  readonly failedDelivery?: true
  readonly stillQueued?: boolean
  // The outcome of the execution that took the message, when this process ran it.
  readonly outcome?: RunOutcome
  // The run status once no execution holds the thread.
  readonly status: ThreadStatus
}

export type WaitingHolder = { kind: "remote"; pid: number } | { kind: "local"; pid: number; operation?: string }

interface SendOptions extends ExecutionOptions {
  readonly interruptedWhileQueued?: Effect.Effect<void>
  readonly onAdmitted?: (seq: number) => void
  readonly onWaiting?: (holder: WaitingHolder) => Effect.Effect<void>
}

export class ThreadSupervisor extends Context.Service<
  ThreadSupervisor,
  {
    readonly holderId: string
    // Runtime section 2: delivers a message from the human side and resolves once the run that takes it has settled.
    readonly send: (
      threadId: string,
      content: string,
      options?: SendOptions,
    ) => Effect.Effect<Delivery, AdmissionError | InvalidOption | SetupError, Registry | Stores>
    readonly control: (threadId: string) => ThreadControl
    // Asks the execution that this process runs for the thread to stop at its next boundary, for the human side.
    readonly stop: (threadId: string) => Effect.Effect<boolean>
    // Interrupts that execution. The run settles idle, and the thread stays open.
    readonly abort: (threadId: string, exiting?: boolean) => Effect.Effect<Execution["settlement"] | undefined>
    // The outcome of the execution that this process runs for the thread, once it settles.
    readonly settled: (threadId: string) => Effect.Effect<RunOutcome | undefined, SqlError | ThreadNotFound>
    readonly status: (threadId: string) => Effect.Effect<ThreadStatus, ThreadNotFound | SqlError>
  }
>()("spindle/ThreadSupervisor") {}

const isCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

// A caller of the runtime's API passes these numbers as plain values, so NaN, Infinity, or a fraction can arrive.
const checkOptions = (options: ExecutionOptions) => {
  if (options.retries !== undefined && !isCount(options.retries))
    return new InvalidOption({ message: `retries must be a whole number of 0 or more, got ${options.retries}` })
  if (options.stepCap !== undefined && !(isCount(options.stepCap) && options.stepCap > 0))
    return new InvalidOption({ message: `stepCap must be a whole number above 0, got ${options.stepCap}` })
  return undefined
}

export const layer = (defaults: ExecutionOptions = {}) =>
  Layer.effect(
    ThreadSupervisor,
    Effect.gen(function* () {
      const runStore = yield* RunStore
      const threadStore = yield* ThreadStore
      let closing = false
      const holder = { id: crypto.randomUUID(), pid: processId }
      yield* runStore.acquireHolder(holder)
      const scope = yield* Scope.fork(yield* Effect.scope, "sequential")
      // The threads that this process runs, and the flows it holds or is about to hold. A claim of this holder whose
      // flow is in neither has no execution behind it.
      const live = new Map<string, Execution>()
      const flows = new Set<string>()
      const senders = new Map<number, Execution | undefined>()

      const statusOf = (threadId: string) =>
        Effect.andThen(
          runStore.recoverLost(threadId),
          Effect.map(threadStore.getThread(threadId), (thread) => thread.status),
        )

      // Register an intended claim before its transaction so the poll cannot recover a flow being started.
      const claimWith = <E>(
        threadId: string,
        take: (flowId: string) => Effect.Effect<boolean, E>,
        options: ExecutionOptions,
      ): Effect.Effect<Execution | undefined, E, Registry | Stores> =>
        Effect.gen(function* () {
          const flowId = crypto.randomUUID()
          flows.add(flowId)
          const claimed = yield* take(flowId).pipe(Effect.onError(() => Effect.sync(() => flows.delete(flowId))))
          if (!claimed) {
            flows.delete(flowId)
            return undefined
          }
          const run = new Execution(flowId, (seq, takingRun) => {
            if (senders.has(seq)) senders.set(seq, takingRun)
          })
          const prior = live.get(threadId)
          if (prior && !prior.ended) prior.cancel("displace")
          live.set(threadId, run)
          const settings = { ...defaults, ...options }
          yield* run.start(
            threadId,
            scope,
            prepareSteps(threadId, run, control(threadId), settings),
            Effect.suspend(() =>
              closing
                ? Effect.undefined
                : claimWith(
                    threadId,
                    (flowId) =>
                      runStore.claim(threadId, { holder: holder.id, flowId }).pipe(Effect.orElseSucceed(() => false)),
                    options,
                  ),
            ),
            () => {
              flows.delete(flowId)
              if (live.get(threadId) === run) live.delete(threadId)
            },
            settings.onHold,
          )
          return run
        }).pipe(Effect.uninterruptible)

      // Runtime sections 2 and 9: the entry is durable when admission returns. An idle thread starts an execution in
      // this process, and an active one takes the entry before its next model call.
      const admit = (
        threadId: string,
        entry: QueueEntry,
        options: SendOptions,
        origin: WriteOrigin,
        waitForDelivery = false,
      ) =>
        Effect.gen(function* () {
          if (originFlow(origin) === null) yield* runStore.recoverLost(threadId)
          let seq = 0
          const started = yield* claimWith(
            threadId,
            (flowId) =>
              Effect.map(
                runStore.admit(threadId, entry, { holder: holder.id, flowId }, origin, waitForDelivery),
                (admitted) => {
                  seq = admitted.queued.seq
                  options.onAdmitted?.(seq)
                  if (waitForDelivery) senders.set(seq, undefined)
                  return admitted.claimed
                },
              ),
            options,
          )
          return { seq, started }
        })

      // Runtime section 10: the thread is marked and its run settled in one transaction. The execution that ran it
      // here is interrupted, and one in another process stops at its next write or its next control poll.
      const terminate = (threadId: string, origin: WriteOrigin) =>
        Effect.gen(function* () {
          const time = yield* runStore.terminate(threadId, origin)
          const local = live.get(threadId)
          if (local) yield* Effect.exit(local.cancel("displace").await)
          return time
        })

      const control = (threadId: string): ThreadControl => ({
        queueMessage: (input, secrets, origin) =>
          Effect.flatMap(queuedMessage(input, secrets), (message) =>
            Effect.asVoid(admit(threadId, { kind: "message", message }, {}, origin)),
          ),
        queueTool: (target, args, origin) =>
          Effect.asVoid(admit(threadId, { kind: "tool", toolName: target, args }, {}, origin)),
        status: statusOf(threadId),
        terminate: (origin) => terminate(threadId, origin),
      })

      // Each poll also settles the runs whose holders died, settles a claim of this holder that has no execution
      // behind it, and interrupts an execution here whose run another process settled, by terminate or as lost.
      const tick = Effect.gen(function* () {
        yield* runStore.recoverLost()
        yield* runStore.pruneHolders()
        const running = [...live]
        const owned = yield* runStore.owned(holder.id)
        for (const [threadId, flowId] of owned)
          if (!flows.has(flowId))
            yield* runStore.settle(
              threadId,
              { flowId },
              { state: "failed", reason: "execution_lost" },
              { continueIfQueued: false, closing: CLOSING.lost },
            )
        for (const [threadId, run] of running)
          if (!run.ended && owned.get(threadId) !== run.flowId) yield* Effect.exit(run.cancel("displace").await)
      })

      yield* Effect.addFinalizer(() => {
        closing = true
        const settlements = [...live.values()].map((run) => run.cancel("displace").await)
        return Effect.forEach(settlements, Effect.exit, { concurrency: 1, discard: true })
      })
      yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(CONTROL_POLL), Effect.ignoreCause(tick))))

      const notifyWaiting = Effect.fnUntraced(function* (
        threadId: string,
        local: Execution | undefined,
        options: SendOptions,
      ) {
        if (!options.onWaiting) return
        if (local) {
          const operation = local.waitingOn
          yield* options.onWaiting({ kind: "local", pid: holder.pid, ...(operation && { operation }) })
        } else {
          const remote = yield* runStore.holderOf(threadId)
          if (remote) yield* options.onWaiting({ kind: "remote", pid: remote.pid })
        }
      })

      const waitForDelivery = (
        threadId: string,
        admitted: { seq: number; started: Execution | undefined },
        options: SendOptions,
      ) =>
        Effect.gen(function* () {
          let started = admitted.started
          let notified = false
          while (true) {
            const local = started ?? senders.get(admitted.seq) ?? live.get(threadId)
            if (!started && !notified) {
              yield* notifyWaiting(threadId, local, options)
              notified = true
            }
            if (local) yield* local.settlement.await
            yield* runStore.recoverLost(threadId)
            const { status, terminated, disposition, settlement } = yield* runStore.senderState(threadId, admitted.seq)
            // No progress ends this send while its entry is still pending, even if cleanup launched a successor.
            // After progress a sender can wait on a running successor without reclaiming the thread itself.
            const stillQueued = disposition === "pending"
            const awaitingRun = !settlement?.finished && !(stillQueued && settlement?.tookEntry === false)
            if (status.state === "running" && awaitingRun) {
              started = undefined
              if (!live.has(threadId)) yield* Effect.sleep("50 millis")
              continue
            }

            const takingRun = senders.get(admitted.seq)
            const reportingRun = takingRun ?? local
            const outcome =
              reportingRun && reportingRun.flowId === settlement?.flowId
                ? yield* reportingRun.settlement.await
                : undefined
            const result = { status: settlement?.status ?? status, ...(outcome && { outcome }) }
            if (disposition === undefined) return result
            if (disposition === "failed_delivery")
              return { ...result, failedDelivery: true as const, stillQueued: false }
            if (terminated !== null) return yield* new ThreadTerminated({ threadId, terminated })
            if (
              !settlement?.tookEntry ||
              settlement.status.reason === "aborted_by_user" ||
              settlement.status.reason === "execution_lost"
            )
              return { ...result, stillQueued }

            started = yield* claimWith(
              threadId,
              (flowId) =>
                runStore.claim(
                  threadId,
                  { holder: holder.id, flowId },
                  { seq: admitted.seq, flowId: settlement.flowId },
                ),
              options,
            )
          }
        }).pipe(
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              if (options.interruptedWhileQueued && (yield* runStore.isQueued(threadId, admitted.seq)))
                yield* options.interruptedWhileQueued
            }),
          ),
        )

      return ThreadSupervisor.of({
        holderId: holder.id,
        send: (threadId, content, options = {}) =>
          Effect.gen(function* () {
            const invalid = checkOptions(options)
            if (invalid !== undefined) return yield* invalid
            const thread = yield* threadStore.getThread(threadId)
            const agent = yield* loadAgent(thread.agentId)
            const message: QueueMessageInput = { role: roleOf(senderSide(agent)), content }
            return yield* Effect.acquireUseRelease(
              admit(threadId, { kind: "message", message }, options, external, true),
              (admitted) => waitForDelivery(threadId, admitted, options),
              (admitted) => {
                senders.delete(admitted.seq)
                return Effect.asVoid(runStore.releaseSender(admitted.seq, holder.id))
              },
            )
          }),
        control,
        stop: (threadId) => Effect.sync(() => live.get(threadId)?.requestStop() ?? false),
        abort: (threadId, exiting) => Effect.sync(() => live.get(threadId)?.cancel(exiting ? "exit" : "hold")),
        settled: (threadId) => Effect.suspend(() => live.get(threadId)?.settlement.await ?? Effect.undefined),
        status: statusOf,
      })
    }),
  )
