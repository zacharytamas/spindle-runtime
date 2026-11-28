import { Cause, Deferred, Effect, Exit, type Fiber, Latch, Scheduler, type Scope } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { FlowEnded, type ThreadNotFound } from "../store/model.ts"
import { RunStore } from "../store/RunStore.ts"
import { ProviderFailure } from "./call.ts"
import type { Callback } from "./callback.ts"
import { CLOSING } from "./run-status.ts"
import type { ExecutionOptions, prepareSteps, RunOutcome, SideScope } from "./step.ts"
import { atRuntimeCap } from "./stop-rules.ts"
import { type PromptSideValue, SetupError, type Side, type SideValue } from "./turn.ts"

export interface End extends Pick<RunOutcome, "status" | "reason" | "error" | "stopTool"> {
  readonly continueIfQueued?: boolean
}

const settledAs = {
  terminated: { status: "idle", reason: "aborted" },
  superseded: { status: "failed", reason: "execution_lost" },
  capped: { status: "idle", reason: "max_total_steps" },
} as const satisfies Record<string, End>

function failure(cause: Cause.Cause<{ readonly message: string }>): End | FlowEnded {
  const found = Cause.findError(cause)
  if (found._tag === "Failure") {
    const defect = Cause.squash(cause)
    return {
      status: "failed",
      reason: "fatal_error",
      error: { message: defect instanceof Error ? defect.message : String(defect) },
    }
  }
  const e = found.success
  if (e instanceof FlowEnded) return e
  const error =
    e instanceof ProviderFailure
      ? {
          message: e.message,
          code: e.code,
          ...(e.statusCode === undefined ? {} : { statusCode: e.statusCode }),
          ...(e.retryAfter === undefined ? {} : { retryAfter: e.retryAfter }),
          ...(e.origin === undefined ? {} : { origin: e.origin }),
          ...(e.upstream === undefined ? {} : { upstream: e.upstream }),
        }
      : { message: e.message }
  return { status: "failed", reason: e instanceof SetupError ? "fatal_error" : "step_error", error }
}

// A scope is local to this execution and to the resolved side of its agent.
class TurnController {
  active: SideValue | undefined
  pending: Side | undefined
  readonly scopes = new Map<PromptSideValue, SideScope>()

  takeTarget() {
    const target = this.pending
    this.pending = undefined
    return target
  }
}

export class Execution {
  readonly flowId: string
  readonly #abort = new AbortController()
  readonly signal = this.#abort.signal
  readonly #pending = new Map<symbol, string>()
  readonly #stopRequested = Latch.makeUnsafe()
  readonly waitForStop = this.#stopRequested.await
  readonly #released = Latch.makeUnsafe()
  readonly #done = Deferred.makeUnsafe<RunOutcome, SqlError | ThreadNotFound>()
  readonly settlement = Object.freeze({
    await: Deferred.await(this.#done),
    isDone: () => Deferred.isDoneUnsafe(this.#done),
  })
  #phase: "running" | "waiting" | "holding" | "dropping" | "ended" = "running"
  #stop: Side | "user" | undefined
  // True when the stop is only the mark of a cancel. Such a run keeps its own rule for queued work at the cap.
  #stopFromCancel = false
  readonly turns = new TurnController()
  readonly #steps = { a: 0, b: 0 }
  #fiber?: Fiber.Fiber<RunOutcome, SqlError | ThreadNotFound>
  #successor: Execution | undefined

  constructor(flowId: string) {
    this.flowId = flowId
  }
  get sideASteps() {
    return this.#steps.a
  }
  get sideBSteps() {
    return this.#steps.b
  }
  get steps() {
    return this.sideASteps + this.sideBSteps
  }
  recordStep(side: Side) {
    this.#steps[side]++
  }
  get ended() {
    return this.#phase === "ended"
  }
  stopAtBoundary() {
    return this.#stop === undefined ? undefined : this.abortEnd
  }
  get stoppedBy() {
    return this.#stop === "user" ? undefined : this.#stop
  }
  get abortEnd() {
    return { status: "idle", reason: this.#stop === "user" ? "aborted_by_user" : "aborted" } as const
  }
  requestStop(by: Side | "user" = "user") {
    // A stop taken while the run waits for its callbacks keeps the run's outcome and leaves queued work queued.
    if (this.#phase !== "running" && this.#phase !== "waiting") return false
    this.#stop ??= by
    this.#stopRequested.openUnsafe()
    return true
  }
  call<A>(callback: Callback, operation: string, invoke: () => PromiseLike<A> | A) {
    return callback.invoke(invoke, () => this.track(operation))
  }
  track(operation: string) {
    const token = Symbol()
    this.#pending.set(token, operation)
    if (this.#phase !== "dropping") this.#released.closeUnsafe()
    return () => {
      this.#pending.delete(token)
      this.#releaseIfReady()
    }
  }
  #releaseIfReady() {
    if (this.#phase === "dropping" || !this.#pending.size) this.#released.openUnsafe()
  }
  get waitingOn() {
    return this.#phase === "holding" || this.#phase === "waiting" ? this.#pending.values().next().value : undefined
  }

  cancel(mode: "hold" | "exit" | "displace") {
    if (!this.ended) {
      const waiting = this.#phase === "waiting"
      if (mode !== "displace" && this.#stop === undefined) {
        this.#stop = "user"
        this.#stopFromCancel = true
      }
      this.#phase = mode === "hold" && this.#phase !== "dropping" ? "holding" : "dropping"
      this.#releaseIfReady()
      if (waiting) this.#abort.abort()
    }
    this.#fiber?.interruptUnsafe()
    return this.settlement
  }

  readonly lastOutcome: Effect.Effect<RunOutcome, SqlError | ThreadNotFound> = Effect.flatMap(
    this.settlement.await,
    (outcome) => this.#successor?.lastOutcome ?? Effect.succeed(outcome),
  )

  #waitForCallbacks(notify: NonNullable<ExecutionOptions["onHold"]>) {
    return Effect.gen({ self: this }, function* () {
      let notificationError: Cause.Cause<never> | undefined
      const operation = this.#pending.values().next().value
      if (operation !== undefined && this.#phase === "running") {
        this.#phase = "waiting"
        const notified = yield* Effect.exit(Effect.interruptible(Effect.suspend(() => notify(operation))))
        if (Exit.isFailure(notified) && !Cause.hasInterruptsOnly(notified.cause)) notificationError = notified.cause
      }
      if (this.#phase === "holding" || this.#phase === "dropping") {
        this.#abort.abort()
        // Return control to the abort caller before publishing the outcome.
        yield* Effect.yieldNow
      }
      while (this.#phase !== "dropping" && this.#pending.size) yield* this.#released.await
      if (this.#phase === "waiting") this.#phase = "running"
      return notificationError
    })
  }

  #settle(store: RunStore["Service"], threadId: string, end: End | FlowEnded, stepCap: number) {
    const settle =
      end instanceof FlowEnded
        ? Effect.succeed(end.why)
        : store.settle(
            threadId,
            { flowId: this.flowId },
            { state: end.status, reason: end.reason },
            {
              continueIfQueued: !!end.continueIfQueued && (this.#stop === undefined || this.#stopFromCancel),
              // A cancelled run never takes queued work itself. At the cap it still ends as the cap ends a run.
              settleOnly: this.#phase === "holding" || this.#phase === "dropping",
              atCap: this.steps >= stepCap,
              closing: end.status === "failed" ? CLOSING.failed : CLOSING.aborted,
            },
          )
    // A poll must not observe the released claim between SQLite commit and this local transition.
    return settle.pipe(
      Effect.map((settlement) => ({ settlement, phase: this.#phase })),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit) || exit.value.settlement !== "continue") this.#phase = "ended"
        }),
      ),
      Effect.provideService(Scheduler.PreventSchedulerYield, true),
    )
  }

  #proposeEnd(
    exit: Exit.Exit<End, { readonly message: string }>,
    interrupted: boolean,
    notify: NonNullable<ExecutionOptions["onHold"]>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const proposed = Exit.isSuccess(exit) ? exit.value : interrupted ? this.abortEnd : failure(exit.cause)
      if (proposed instanceof FlowEnded) {
        this.#abort.abort()
        return proposed
      }
      const notificationError = yield* this.#waitForCallbacks(notify)
      return notificationError ? failure(notificationError) : proposed
    })
  }

  #finish(threadId: string, steps: ReturnType<typeof prepareSteps>, onHold?: ExecutionOptions["onHold"]) {
    return Effect.gen({ self: this }, function* () {
      const store = yield* RunStore
      const { advance, report, stepCap } = yield* steps
      const notify = (operation: string) => {
        const once = onHold
        onHold = undefined
        return once?.(operation) ?? Effect.void
      }
      while (true) {
        const exit = yield* Effect.exit(Effect.interruptible(advance))
        const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        const proposed = yield* this.#proposeEnd(exit, interrupted, notify)
        const end: End = proposed instanceof FlowEnded ? settledAs[proposed.why] : proposed
        const { settlement, phase } = yield* this.#settle(store, threadId, proposed, stepCap)
        if (settlement === "continue") continue
        const result = settlement === "settled" ? end : settledAs[settlement]
        // A run that ended at the step cap leaves queued work for the next trigger, whatever ended its wait.
        const restart =
          settlement === "settled" && phase === "holding" && end.status === "idle" && !atRuntimeCap(end.reason)
        const brief = interrupted || phase === "holding" || phase === "dropping"
        const details = report(result, brief)
        const outcome =
          Exit.isFailure(exit) || brief
            ? yield* details
            : yield* Effect.interruptible(details).pipe(
                Effect.catchCauseIf(Cause.hasInterruptsOnly, () => {
                  this.#abort.abort()
                  return report(result, true)
                }),
              )
        return { outcome, restart }
      }
    })
  }

  start<R>(
    threadId: string,
    scope: Scope.Scope,
    steps: ReturnType<typeof prepareSteps>,
    resume: Effect.Effect<Execution | undefined, never, R>,
    remove: () => void,
    onHold?: ExecutionOptions["onHold"],
  ) {
    // Mask the driver before its first turn. Only the work between settlement boundaries is interruptible.
    const publish = Effect.gen({ self: this }, function* () {
      const { outcome, restart } = yield* this.#finish(threadId, steps, onHold)
      if (restart) this.#successor = yield* resume
      return outcome
    }).pipe(
      Effect.onExit((exit) => {
        this.turns.scopes.clear()
        remove()
        return Deferred.done(this.#done, exit)
      }),
    )
    return Effect.map(Effect.forkIn(Effect.scoped(publish), scope, { uninterruptible: true }), (fiber) => {
      this.#fiber = fiber
      if (this.#phase === "holding" || this.#phase === "dropping") fiber.interruptUnsafe()
    })
  }
}
