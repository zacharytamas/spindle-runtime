import type { AttachmentRef, QueueMessageInput, ThreadStatus } from "@standardagents/spec"
import { Cause, Context, Data, Deferred, Duration, Effect, Exit, Fiber, Layer, Scheduler, Scope } from "effect"
import { processId } from "#platform"
import type { Registry } from "../registry/Registry.ts"
import { isAttachmentRef } from "../store/schema.ts"
import { type Holder, type QueueEntry, ThreadStore, ThreadTerminated, WritingHandle } from "../store/ThreadStore.ts"
import type { Secrets } from "./env.ts"
import { redactMetadata } from "./messages.ts"
import { redactor } from "./redact.ts"
import { CLOSING } from "./run-status.ts"
import { type ExecutionOptions, type RunOutcome, runExecution } from "./step.ts"
import type { Run, ThreadControl } from "./thread-state.ts"
import { QueueRefused, redactAttachment } from "./tools.ts"
import { roleOf, sidesOf } from "./turn.ts"

const CONTROL_POLL = Duration.millis(250)

export class InvalidOption extends Data.TaggedError("InvalidOption")<{ readonly message: string }> {}

export interface Delivery {
  readonly stillQueued?: boolean
  // The outcome of the execution that took the message, when this process ran it.
  readonly outcome?: RunOutcome
  // The holder that ran the thread, when another process did.
  readonly elsewhere?: Holder
  // The run status once no execution holds the thread.
  readonly status: ThreadStatus
}

interface Live {
  readonly run: Run
  successor?: Live
  readonly done: Deferred.Deferred<RunOutcome, unknown>
  fiber: Fiber.Fiber<void, unknown> | undefined
}

export class ThreadSupervisor extends Context.Service<
  ThreadSupervisor,
  {
    readonly holderId: string
    // Runtime section 2: delivers a message from the human side and resolves once the run that takes it has settled.
    readonly send: (
      threadId: string,
      content: string,
      options?: ExecutionOptions,
    ) => Effect.Effect<Delivery, unknown, Registry | ThreadStore>
    readonly control: (threadId: string) => ThreadControl
    // Asks the execution that this process runs for the thread to stop at its next boundary, for the human side.
    readonly stop: (threadId: string) => Effect.Effect<boolean>
    // Interrupts that execution. The run settles idle, and the thread stays open.
    readonly abort: (threadId: string, exiting?: boolean) => Effect.Effect<boolean>
    // The outcome of the execution that this process runs for the thread, once it settles.
    readonly settled: (threadId: string) => Effect.Effect<RunOutcome | undefined, unknown>
    readonly status: (threadId: string) => Effect.Effect<ThreadStatus, unknown>
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
      const store = yield* ThreadStore
      const scope = yield* Scope.fork(yield* Effect.scope, "sequential")
      let closing = false
      const holder = { id: crypto.randomUUID(), pid: processId }
      // The threads that this process runs, and the flows it holds or is about to hold. A claim of this holder whose
      // flow is in neither has no execution behind it.
      const live = new Map<string, Live>()
      const flows = new Set<string>()

      const statusOf = (threadId: string) =>
        Effect.andThen(
          store.recover(threadId),
          Effect.map(store.getThread(threadId), (thread) => thread.status),
        )

      const start = (
        threadId: string,
        run: Run,
        options: ExecutionOptions,
      ): Effect.Effect<Live, never, ThreadStore | Registry> =>
        Effect.gen(function* () {
          const entry: Live = { run, done: yield* Deferred.make<RunOutcome, unknown>(), fiber: undefined }
          const previous = live.get(threadId)
          if (previous && !previous.run.ended) {
            previous.run.displaced = true
            previous.run.releaseWait.abort()
            previous.fiber?.interruptUnsafe()
          }
          live.set(threadId, entry)
          // An execution yields to other fibers only where it waits, for a model, a tool, or a hook, so its store calls
          // take the writer lock without a scheduler yield. The outcome is recorded in a finalizer, which an interrupt cannot cut short.
          const execution = runExecution(threadId, run, control(threadId), { ...defaults, ...options }).pipe(
            Effect.provideService(WritingHandle, undefined),
            Effect.provideService(Scheduler.PreventSchedulerYield, true),
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                flows.delete(run.flowId)
                if (live.get(threadId) === entry) live.delete(threadId)
                // An interrupted run settled itself. Its outcome is the status the store holds.
                if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
                  return yield* Deferred.failCause(entry.done, exit.cause)
                const outcome: RunOutcome = Exit.isSuccess(exit)
                  ? exit.value
                  : yield* store.getThread(threadId).pipe(
                      Effect.map((stored) => stored.status),
                      Effect.onError((cause) => Deferred.failCause(entry.done, cause)),
                      Effect.map((status) => ({
                        threadId,
                        flowId: run.flowId,
                        status: run.displaced || status.state === "failed" ? ("failed" as const) : ("idle" as const),
                        reason: run.displaced ? "execution_lost" : (status.reason ?? "aborted"),
                        steps: run.steps,
                        trace: [],
                        modelCalls: [],
                      })),
                    )
                if (run.resumeQueued && !closing) {
                  const next = newRun()
                  flows.add(next.flowId)
                  if (
                    yield* store
                      .claim(threadId, { holder: holder.id, flowId: next.flowId })
                      .pipe(Effect.orElseSucceed(() => false))
                  )
                    entry.successor = yield* start(threadId, next, options)
                  else flows.delete(next.flowId)
                }
                yield* Deferred.succeed(entry.done, outcome)
              }),
            ),
            Effect.asVoid,
          )
          // Start masked so an interrupt before the first scheduler turn still runs both settlement finalizers.
          entry.fiber = yield* Effect.forkIn(execution, scope, { uninterruptible: true })
          return entry
        })

      // Runtime sections 2 and 9: the entry is durable when admission returns. An idle thread starts an execution in
      // this process, and an active one takes the entry before its next model call.
      const newRun = (): Run => ({
        pending: new Set(),
        releaseWait: new AbortController(),
        flowId: crypto.randomUUID(),
        abort: new AbortController(),
        stop: undefined,
        steps: 0,
        ended: false,
      })

      // The flow is known here before the claim commits, so that the control poll never takes the new claim for one with no
      // execution behind it.
      const claimWith = <E>(
        threadId: string,
        take: (run: Run) => Effect.Effect<boolean, E>,
        options: ExecutionOptions,
      ) =>
        Effect.gen(function* () {
          const run = newRun()
          flows.add(run.flowId)
          const claimed = yield* take(run).pipe(Effect.onError(() => Effect.sync(() => flows.delete(run.flowId))))
          if (claimed) return yield* start(threadId, run, options)
          flows.delete(run.flowId)
          return undefined
        }).pipe(Effect.uninterruptible)

      // Runtime sections 2 and 9: the entry is durable when admission returns. An idle thread starts an execution in
      // this process, and an active one takes the entry before its next model call.
      const admit = (threadId: string, entry: QueueEntry, options: ExecutionOptions) =>
        Effect.gen(function* () {
          if ((yield* WritingHandle)?.flowId === undefined) yield* store.recover(threadId)
          let seq = 0
          const started = yield* claimWith(
            threadId,
            (run) =>
              Effect.map(store.admit(threadId, entry, { holder: holder.id, flowId: run.flowId }), (admitted) => {
                seq = admitted.queued.seq
                return admitted.claimed
              }),
            options,
          )
          return { seq, started }
        })

      // Runtime section 10: the thread is marked and its run settled in one transaction. The execution that ran it
      // here is interrupted, and one in another process stops at its next write or its next control poll.
      const terminate = (threadId: string) =>
        Effect.gen(function* () {
          const time = yield* store.terminate(threadId)
          const local = live.get(threadId)
          if (local?.fiber !== undefined) {
            local.run.releaseWait.abort()
            yield* Fiber.interrupt(local.fiber)
          }
          return time
        })

      const control = (threadId: string): ThreadControl => ({
        queueMessage: (input, secrets) =>
          Effect.flatMap(queuedMessage(input, secrets), (message) =>
            Effect.asVoid(admit(threadId, { kind: "message", message }, {})),
          ),
        queueTool: (target, args) => Effect.asVoid(admit(threadId, { kind: "tool", toolName: target, args }, {})),
        status: statusOf(threadId),
        terminate: terminate(threadId),
      })

      // Waits until no execution holds the thread. A holder in another process is watched through the store.
      const awaitRest = (threadId: string): Effect.Effect<ThreadStatus, unknown> =>
        Effect.gen(function* () {
          while (true) {
            const local = live.get(threadId)
            if (local !== undefined) yield* Deferred.await(local.done)
            const status = yield* statusOf(threadId)
            if (status.state !== "running") return status
            yield* Effect.sleep("50 millis")
          }
        })

      // Each poll also settles the runs whose holders died, settles a claim of this holder that has no execution
      // behind it, and interrupts an execution here whose run another process settled, by terminate or as lost.
      const tick = Effect.gen(function* () {
        yield* store.recover()
        const running = [...live]
        const owned = yield* store.owned(holder.id)
        for (const [threadId, flowId] of owned)
          if (!flows.has(flowId))
            yield* store.settle(
              threadId,
              flowId,
              { state: "failed", reason: "execution_lost" },
              { continueIfQueued: false, closing: CLOSING.lost },
            )
        for (const [threadId, entry] of running)
          if (!entry.run.ended && owned.get(threadId) !== entry.run.flowId && entry.fiber !== undefined) {
            entry.run.displaced = (yield* store.getThread(threadId)).terminated === null
            entry.run.releaseWait.abort()
            yield* Fiber.interrupt(entry.fiber)
          }
      })

      // A process that shuts down aborts its executions, which settle, and drops its holder record last.
      yield* Effect.addFinalizer(() => {
        closing = true
        for (const { run } of live.values()) run.releaseWait.abort()
        return Effect.andThen(
          Fiber.interruptAll([...live.values()].flatMap((entry) => (entry.fiber === undefined ? [] : [entry.fiber]))),
          Effect.ignore(store.dropHolder(holder.id)),
        )
      })
      yield* store.registerHolder(holder)
      yield* Effect.forkIn(Effect.forever(Effect.andThen(Effect.sleep(CONTROL_POLL), Effect.ignoreCause(tick))), scope)

      return ThreadSupervisor.of({
        holderId: holder.id,
        // A sender waits for the run that takes its message. When the run it waited behind stopped or failed and left
        // the message queued, the sender claims the thread and runs it, because the message is its deliberate request.
        // A run that was lost leaves the queue to the next trigger, and a terminated thread runs nothing.
        send: (threadId, content, options = {}) =>
          Effect.gen(function* () {
            const invalid = checkOptions(options)
            if (invalid !== undefined) return yield* invalid
            const thread = yield* store.getThread(threadId)
            const { human } = yield* sidesOf(thread.agentId)
            const message: QueueMessageInput = { role: roleOf(human), content }
            const admitted = yield* admit(threadId, { kind: "message", message }, options)
            let started = admitted.started
            let elsewhere: Holder | undefined
            while (true) {
              if (started !== undefined) {
                const outcome = yield* Deferred.await(started.done)
                return { outcome, status: yield* statusOf(threadId) }
              }
              let local = live.get(threadId)
              let outcome: RunOutcome | undefined
              if (local !== undefined) {
                while (local) {
                  outcome = yield* Deferred.await(local.done)
                  local = local.successor
                }
              } else {
                const holderNow = yield* store.holderOf(threadId)
                if (holderNow !== null) {
                  elsewhere = holderNow
                  if (options.observe !== undefined)
                    yield* options.observe({ type: "queued", threadId, pid: holderNow.pid })
                }
              }
              const status = yield* awaitRest(threadId).pipe(
                Effect.onInterrupt(() =>
                  Effect.gen(function* () {
                    if (options.observe && (yield* store.isQueued(threadId, admitted.seq)))
                      yield* options.observe({ type: "interrupted_while_queued" })
                  }),
                ),
              )
              const current = yield* store.getThread(threadId)
              if (current.terminated !== null)
                return yield* new ThreadTerminated({ threadId, terminated: current.terminated })
              const stillQueued = yield* store.isQueued(threadId, admitted.seq)
              if (status.reason === "execution_lost" || !stillQueued) {
                const delivery = { status, stillQueued, ...(elsewhere === undefined ? {} : { elsewhere }) }
                return outcome === undefined ? delivery : { ...delivery, outcome }
              }
              started = yield* claimWith(
                threadId,
                (run) => store.claim(threadId, { holder: holder.id, flowId: run.flowId }),
                options,
              )
            }
          }),
        control,
        stop: (threadId) =>
          Effect.sync(() => {
            const local = live.get(threadId)
            if (local === undefined || local.run.ended) return false
            local.run.stop ??= { reason: "aborted_by_user" }
            return true
          }),
        abort: (threadId, exiting = false) =>
          Effect.sync(() => {
            const local = live.get(threadId)
            if (local?.fiber === undefined) return false
            local.run.stop ??= { reason: "aborted_by_user" }
            local.run.waitForCallbacks = !exiting
            if (exiting) local.run.releaseWait.abort()
            local.fiber.interruptUnsafe()
            return true
          }),
        settled: (threadId) =>
          Effect.suspend(() => {
            const local = live.get(threadId)
            return local === undefined ? Effect.succeed(undefined) : Deferred.await(local.done)
          }),
        status: statusOf,
      })
    }),
  )
