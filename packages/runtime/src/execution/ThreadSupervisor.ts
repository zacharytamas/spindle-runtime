import type { AttachmentRef, QueueMessageInput, ThreadStatus } from "@standardagents/spec"
import { Context, Data, Deferred, Duration, Effect, Exit, Fiber, Layer } from "effect"
import { processId } from "#platform"
import type { Registry } from "../registry/Registry.ts"
import { type Holder, type QueueEntry, ThreadStore } from "../store/ThreadStore.ts"
import type { Secrets } from "./env.ts"
import { redactMetadata } from "./messages.ts"
import { redactor } from "./redact.ts"
import { CLOSING } from "./run-status.ts"
import { type ExecutionOptions, type RunOutcome, runExecution } from "./step.ts"
import type { Run, ThreadControl } from "./thread-state.ts"
import { QueueRefused } from "./tools.ts"
import { roleOf, sidesOf } from "./turn.ts"

// How long a holder's lease lasts after each renewal. A holder renews it five times in that span, so a process
// counts as dead only when it has been silent for the whole span, whatever one model call or tool takes.
export const HolderTimeout = Context.Reference<Duration.Duration>("spindle/HolderTimeout", {
  defaultValue: () => Duration.seconds(15),
})

export class InvalidOption extends Data.TaggedError("InvalidOption")<{ readonly message: string }> {}

export interface Delivery {
  // The outcome of the execution that took the message, when this process ran it.
  readonly outcome?: RunOutcome
  // The holder that ran the thread, when another process did.
  readonly elsewhere?: Holder
  // The run status once no execution holds the thread.
  readonly status: ThreadStatus
}

interface Live {
  readonly run: Run
  readonly done: Deferred.Deferred<RunOutcome>
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
    readonly abort: (threadId: string) => Effect.Effect<boolean>
    // The outcome of the execution that this process runs for the thread, once it settles.
    readonly settled: (threadId: string) => Effect.Effect<RunOutcome | undefined>
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

const isAttachmentRef = (value: unknown): value is AttachmentRef =>
  isRecord(value) &&
  value.type === "file" &&
  typeof value.id === "string" &&
  typeof value.path === "string" &&
  typeof value.name === "string" &&
  typeof value.mimeType === "string" &&
  isCount(value.size)

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
      ...(attachments.length === 0 ? {} : { attachments: attachments as Array<AttachmentRef> }),
    } satisfies QueueMessageInput
  })

export const layer = (defaults: ExecutionOptions = {}) =>
  Layer.effect(
    ThreadSupervisor,
    Effect.gen(function* () {
      const store = yield* ThreadStore
      const scope = yield* Effect.scope
      const timeout = yield* HolderTimeout
      const holder = { id: crypto.randomUUID(), pid: processId }
      const leaseMicros = Math.round(Duration.toMillis(timeout) * 1000)
      // The threads that this process runs, and the flows it holds or is about to hold. A claim of this holder whose
      // flow is in neither has no execution behind it.
      const live = new Map<string, Live>()
      const flows = new Set<string>()

      const statusOf = (threadId: string) =>
        Effect.andThen(
          store.recover(threadId),
          Effect.map(store.getThread(threadId), (thread) => thread.status),
        )

      const start = (threadId: string, run: Run, options: ExecutionOptions) =>
        Effect.gen(function* () {
          const entry: Live = { run, done: yield* Deferred.make<RunOutcome>(), fiber: undefined }
          live.set(threadId, entry)
          // The outcome is recorded in a finalizer, which an interrupt cannot cut short.
          const execution = runExecution(threadId, run, control(threadId), { ...defaults, ...options }).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                flows.delete(run.flowId)
                if (live.get(threadId) === entry) live.delete(threadId)
                // An interrupted run settled itself. Its outcome is the status the store holds.
                const outcome: RunOutcome = Exit.isSuccess(exit)
                  ? exit.value
                  : yield* store.getThread(threadId).pipe(
                      Effect.map((stored) => stored.status),
                      Effect.orElseSucceed(() => ({ state: "idle" as const, since: 0, reason: "aborted" })),
                      Effect.map((status) => ({
                        threadId,
                        flowId: run.flowId,
                        status: status.state === "failed" ? ("failed" as const) : ("idle" as const),
                        reason: status.reason ?? "aborted",
                        steps: run.steps,
                        trace: [],
                        modelCalls: [],
                      })),
                    )
                yield* Deferred.succeed(entry.done, outcome)
              }),
            ),
            Effect.asVoid,
          )
          entry.fiber = yield* Effect.forkIn(execution, scope)
          return entry
        })

      // Runtime sections 2 and 9: the entry is durable when admission returns. An idle thread starts an execution in
      // this process, and an active one takes the entry before its next model call.
      const admit = (threadId: string, entry: QueueEntry, options: ExecutionOptions) =>
        Effect.gen(function* () {
          yield* store.recover(threadId)
          const run: Run = {
            flowId: crypto.randomUUID(),
            abort: new AbortController(),
            stop: undefined,
            steps: 0,
            ended: false,
          }
          flows.add(run.flowId)
          const admitted = yield* store
            .admit(threadId, entry, { holder: holder.id, flowId: run.flowId })
            .pipe(Effect.onError(() => Effect.sync(() => flows.delete(run.flowId))))
          if (admitted.claimed) return yield* start(threadId, run, options)
          flows.delete(run.flowId)
          return undefined
        })

      // Runtime section 10: the thread is marked and its run settled in one transaction. The execution that ran it
      // here is interrupted, and one in another process stops at its next write or its next renewal.
      const terminate = (threadId: string) =>
        Effect.gen(function* () {
          yield* store.terminate(threadId)
          const local = live.get(threadId)
          if (local?.fiber !== undefined) yield* Fiber.interrupt(local.fiber)
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

      // Every renewal also settles the runs whose holders died, settles a claim of this holder that has no execution
      // behind it, and interrupts an execution here whose run another process settled, by terminate or as lost.
      const tick = Effect.gen(function* () {
        yield* store.beat(holder, leaseMicros)
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
          if (owned.get(threadId) !== entry.run.flowId && entry.fiber !== undefined) yield* Fiber.interrupt(entry.fiber)
      })

      // A process that shuts down aborts its executions, which settle, and gives up its lease last. Finalizers run in
      // reverse order, so the renewals stop before this one runs.
      yield* Effect.addFinalizer(() =>
        Effect.andThen(
          Fiber.interruptAll([...live.values()].flatMap((entry) => (entry.fiber === undefined ? [] : [entry.fiber]))),
          Effect.ignore(store.dropHolder(holder.id)),
        ),
      )
      yield* store.beat(holder, leaseMicros)
      yield* Effect.forkIn(
        Effect.forever(
          Effect.andThen(Effect.sleep(Duration.millis(Duration.toMillis(timeout) / 5)), Effect.ignoreCause(tick)),
        ),
        scope,
      )

      return ThreadSupervisor.of({
        holderId: holder.id,
        send: (threadId, content, options = {}) =>
          Effect.gen(function* () {
            const invalid = checkOptions(options)
            if (invalid !== undefined) return yield* invalid
            const thread = yield* store.getThread(threadId)
            const { human } = yield* sidesOf(thread.agentId)
            const message: QueueMessageInput = { role: roleOf(human), content }
            const started = yield* admit(threadId, { kind: "message", message }, options)
            if (started !== undefined) {
              const outcome = yield* Deferred.await(started.done)
              return { outcome, status: yield* statusOf(threadId) }
            }
            // The running execution takes the message before it settles.
            const local = live.get(threadId)
            if (local !== undefined) {
              const outcome = yield* Deferred.await(local.done)
              return { outcome, status: yield* awaitRest(threadId) }
            }
            const elsewhere = yield* store.holderOf(threadId)
            if (options.observe !== undefined)
              yield* options.observe({ type: "queued", threadId, pid: elsewhere?.pid ?? null })
            const status = yield* awaitRest(threadId)
            return elsewhere === null ? { status } : { elsewhere, status }
          }),
        control,
        stop: (threadId) =>
          Effect.sync(() => {
            const local = live.get(threadId)
            if (local === undefined || local.run.ended) return false
            local.run.stop ??= { reason: "aborted_by_user" }
            return true
          }),
        abort: (threadId) =>
          Effect.gen(function* () {
            const local = live.get(threadId)
            if (local?.fiber === undefined) return false
            local.run.stop ??= { reason: "aborted_by_user" }
            yield* Fiber.interrupt(local.fiber)
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
