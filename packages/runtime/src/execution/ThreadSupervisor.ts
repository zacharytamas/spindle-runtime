import type { AttachmentRef, QueueMessageInput, ThreadStatus } from "@standardagents/spec"
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
import { isAttachmentRef } from "../store/schema.ts"
import type { Stores } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import { Execution } from "./Execution.ts"
import type { Secrets } from "./env.ts"
import { redactMetadata } from "./messages.ts"
import { redactor } from "./redact.ts"
import { CLOSING } from "./run-status.ts"
import { type ExecutionOptions, prepareSteps, type RunOutcome } from "./step.ts"
import type { AdmissionError, ThreadControl } from "./thread-state.ts"
import { QueueRefused, redactAttachment } from "./tools.ts"
import { roleOf, type SetupError, sidesOf } from "./turn.ts"

const CONTROL_POLL = Duration.millis(250)

class InvalidOption extends Data.TaggedError("InvalidOption")<{ readonly message: string }> {}

export interface Delivery {
  readonly stillQueued?: boolean
  // The outcome of the execution that took the message, when this process ran it.
  readonly outcome?: RunOutcome
  // The run status once no execution holds the thread.
  readonly status: ThreadStatus
}

export type WaitingHolder = { kind: "remote"; pid: number } | { kind: "local"; pid: number; abortedOperation?: string }

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

// A caller of the runtime's API passes these numbers as plain values, so NaN, Infinity, or a fraction can arrive.
const checkOptions = (options: ExecutionOptions) => {
  if (options.retries !== undefined && !isCount(options.retries))
    return new InvalidOption({ message: `retries must be a whole number of 0 or more, got ${options.retries}` })
  if (options.stepCap !== undefined && !(isCount(options.stepCap) && options.stepCap > 0))
    return new InvalidOption({ message: `stepCap must be a whole number above 0, got ${options.stepCap}` })
  return undefined
}

// Messages section 4. A queued message is user code's text, so it is redacted before the queue stores it. A new file
// needs the thread file system, which arrives in M3.
const queuedMessage = (input: QueueMessageInput, secrets: Secrets) =>
  Effect.gen(function* () {
    const refuse = (problem: string) => new QueueRefused({ message: `queueMessage ${problem}` })
    if (!isRecord(input)) return yield* refuse("takes an object with a role and content")
    if (input.role !== "user" && input.role !== "assistant")
      return yield* refuse(`takes the role user or assistant, got ${JSON.stringify(input.role)}`)
    if (typeof input.content !== "string") return yield* refuse("takes content that is a string")
    if (input.silent !== undefined && typeof input.silent !== "boolean")
      return yield* refuse("takes silent as a boolean")
    if (input.metadata !== undefined && !isRecord(input.metadata)) return yield* refuse("takes metadata as an object")
    const attachments: ReadonlyArray<unknown> = input.attachments ?? []
    if (!Array.isArray(attachments)) return yield* refuse("takes attachments as an array")
    for (const item of attachments)
      if (!isAttachmentRef(item))
        return yield* refuse(
          isRecord(item) && typeof item.data === "string"
            ? "cannot store a new file in this version of Spindle. The thread file system arrives in M3, so pass a reference to a stored file."
            : "takes attachments that are references to stored files",
        )
    const redact = redactor(secrets.values)
    return {
      role: input.role,
      content: redact(input.content),
      ...(input.silent === undefined ? {} : { silent: input.silent }),
      ...(input.metadata === undefined ? {} : { metadata: redactMetadata(input.metadata, redact) }),
      ...(attachments.length === 0
        ? {}
        : {
            attachments: attachments.map((item) =>
              redactAttachment(item as Record<string, unknown>, redact),
            ) as Array<AttachmentRef>,
          }),
    } satisfies QueueMessageInput
  })

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
          const run = new Execution(flowId)
          const prior = live.get(threadId)
          if (prior && !prior.ended) prior.cancel("displace")
          live.set(threadId, run)
          yield* run.start(
            threadId,
            scope,
            prepareSteps(threadId, run, control(threadId), { ...defaults, ...options }),
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
          )
          return run
        }).pipe(Effect.uninterruptible)

      // Runtime sections 2 and 9: the entry is durable when admission returns. An idle thread starts an execution in
      // this process, and an active one takes the entry before its next model call.
      const admit = (threadId: string, entry: QueueEntry, options: SendOptions, origin: WriteOrigin) =>
        Effect.gen(function* () {
          if (originFlow(origin) === null) yield* runStore.recoverLost(threadId)
          let seq = 0
          const started = yield* claimWith(
            threadId,
            (flowId) =>
              Effect.map(runStore.admit(threadId, entry, { holder: holder.id, flowId }, origin), (admitted) => {
                seq = admitted.queued.seq
                options.onAdmitted?.(seq)
                return admitted.claimed
              }),
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

      // Waits until no execution holds the thread. A holder in another process is watched through the store.
      const awaitRest = (threadId: string): Effect.Effect<ThreadStatus, ThreadNotFound | SqlError> =>
        Effect.gen(function* () {
          while (true) {
            const local = live.get(threadId)
            if (local !== undefined) yield* local.settlement.await
            const status = yield* statusOf(threadId)
            if (status.state !== "running") return status
            yield* Effect.sleep("50 millis")
          }
        })

      // Each poll also settles the runs whose holders died, settles a claim of this holder that has no execution
      // behind it, and interrupts an execution here whose run another process settled, by terminate or as lost.
      const tick = Effect.gen(function* () {
        yield* runStore.recoverLost()
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

      return ThreadSupervisor.of({
        holderId: holder.id,
        // A sender waits for the run that takes its message. When the run it waited behind stopped or failed and left
        // the message queued, the sender claims the thread and runs it, because the message is its deliberate request.
        // A run that was lost leaves the queue to the next trigger, and a terminated thread runs nothing.
        send: (threadId, content, options = {}) =>
          Effect.gen(function* () {
            const invalid = checkOptions(options)
            if (invalid !== undefined) return yield* invalid
            const thread = yield* threadStore.getThread(threadId)
            const { human } = yield* sidesOf(thread.agentId)
            const message: QueueMessageInput = { role: roleOf(human), content }
            const admitted = yield* admit(threadId, { kind: "message", message }, options, external)
            let started = admitted.started
            while (true) {
              if (started !== undefined) {
                const outcome = yield* started.settlement.await
                return { outcome, status: yield* statusOf(threadId) }
              }
              const local = live.get(threadId)
              let outcome: RunOutcome | undefined
              if (local !== undefined) {
                if (options.onWaiting) {
                  const operation = local.waitingOn
                  yield* options.onWaiting({
                    kind: "local",
                    pid: holder.pid,
                    ...(operation ? { abortedOperation: operation } : {}),
                  })
                }
                outcome = yield* local.lastOutcome
              } else {
                const holderNow = yield* runStore.holderOf(threadId)
                if (holderNow && options.onWaiting) yield* options.onWaiting({ kind: "remote", pid: holderNow.pid })
              }
              const status = yield* awaitRest(threadId).pipe(
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    if (options.interruptedWhileQueued && (yield* runStore.isQueued(threadId, admitted.seq)))
                      yield* options.interruptedWhileQueued
                  }),
                ),
              )
              const current = yield* threadStore.getThread(threadId)
              if (current.terminated !== null)
                return yield* new ThreadTerminated({ threadId, terminated: current.terminated })
              const stillQueued = yield* runStore.isQueued(threadId, admitted.seq)
              if (status.reason === "execution_lost" || !stillQueued) {
                return { status, stillQueued, ...(outcome && { outcome }) }
              }
              started = yield* claimWith(
                threadId,
                (flowId) => runStore.claim(threadId, { holder: holder.id, flowId }),
                options,
              )
            }
          }),
        control,
        stop: (threadId) => Effect.sync(() => live.get(threadId)?.requestStop() ?? false),
        abort: (threadId, exiting) => Effect.sync(() => live.get(threadId)?.cancel(exiting ? "exit" : "hold")),
        settled: (threadId) => Effect.suspend(() => live.get(threadId)?.settlement.await ?? Effect.undefined),
        status: statusOf,
      })
    }),
  )
