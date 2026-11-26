import { Cause, Deferred, Effect, Exit, type Fiber, Latch, Scheduler, type Scope } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import { FlowEnded, type ThreadNotFound } from "../store/model.ts"
import { RunStore } from "../store/RunStore.ts"
import { ProviderFailure } from "./call.ts"
import { CLOSING } from "./run-status.ts"
import type { prepareSteps, RunOutcome } from "./step.ts"
import { SetupError, type Side } from "./turn.ts"

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

export class Execution {
  readonly flowId: string
  readonly #abort = new AbortController()
  readonly signal = this.#abort.signal
  readonly #pending = new Map<Promise<unknown>, string>()
  readonly #released = Latch.makeUnsafe()
  readonly #done = Deferred.makeUnsafe<RunOutcome, SqlError | ThreadNotFound>()
  readonly settlement = Object.freeze({
    await: Deferred.await(this.#done),
    isDone: () => Deferred.isDoneUnsafe(this.#done),
  })
  #phase: "running" | "holding" | "dropping" | "ended" = "running"
  #stop: Side | "user" | undefined
  #steps = 0
  #fiber?: Fiber.Fiber<RunOutcome, SqlError | ThreadNotFound>
  #successor: Execution | undefined

  constructor(flowId: string) {
    this.flowId = flowId
  }
  get steps() {
    return this.#steps
  }
  recordStep() {
    this.#steps++
  }
  get ended() {
    return this.#phase === "ended"
  }
  stopped = () => this.#stop !== undefined
  get stoppedBy() {
    return this.#stop === "user" ? undefined : this.#stop
  }
  get stopReason() {
    return this.#stop === "user" ? "aborted_by_user" : "aborted"
  }
  requestStop(by: Side | "user" = "user") {
    if (this.#phase !== "running") return false
    this.#stop ??= by
    return true
  }
  track(promise: Promise<unknown>, operation: string) {
    this.#pending.set(promise, operation)
    if (this.#phase === "holding") this.#released.closeUnsafe()
  }
  forget(promise: Promise<unknown>) {
    this.#pending.delete(promise)
    this.#releaseIfReady()
  }
  #releaseIfReady() {
    if (this.#phase === "dropping" || (this.#phase === "holding" && !this.#pending.size)) this.#released.openUnsafe()
  }
  get waitingOn() {
    return this.#phase === "holding" ? this.#pending.values().next().value : undefined
  }

  cancel(mode: "hold" | "exit" | "displace") {
    if (!this.ended) {
      if (mode !== "displace") this.#stop ??= "user"
      this.#phase = mode === "hold" && this.#phase !== "dropping" ? "holding" : "dropping"
      this.#releaseIfReady()
    }
    this.#fiber?.interruptUnsafe()
    return this.settlement
  }

  readonly lastOutcome: Effect.Effect<RunOutcome, SqlError | ThreadNotFound> = Effect.flatMap(
    this.settlement.await,
    (outcome) => this.#successor?.lastOutcome ?? Effect.succeed(outcome),
  )

  start<R>(
    threadId: string,
    scope: Scope.Scope,
    steps: ReturnType<typeof prepareSteps>,
    resume: Effect.Effect<Execution | undefined, never, R>,
    remove: () => void,
  ) {
    const finish = Effect.gen({ self: this }, function* () {
      const store = yield* RunStore
      const { advance, report, stepCap } = yield* steps
      while (true) {
        const exit = yield* Effect.exit(Effect.interruptible(advance))
        const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
        if (interrupted) {
          this.#abort.abort()
          // Return control to the abort caller before publishing the interrupted outcome.
          yield* Effect.yieldNow
          if (this.#phase === "holding") yield* this.#released.await
        }
        const proposed: End | FlowEnded = Exit.isSuccess(exit)
          ? exit.value
          : interrupted
            ? { status: "idle", reason: this.stopReason }
            : failure(exit.cause)
        const end: End = proposed instanceof FlowEnded ? settledAs[proposed.why] : proposed
        if (proposed instanceof FlowEnded) this.#abort.abort()
        const settle =
          proposed instanceof FlowEnded
            ? Effect.succeed(proposed.why)
            : store.settle(
                threadId,
                { flowId: this.flowId },
                { state: end.status, reason: end.reason },
                {
                  continueIfQueued: !!end.continueIfQueued,
                  atCap: this.steps >= stepCap,
                  closing: end.status === "failed" ? CLOSING.failed : CLOSING.aborted,
                },
              )
        const holding = this.#phase === "holding"
        // A poll must not observe the released claim between SQLite commit and this local transition.
        const settlement = yield* settle.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) || exit.value !== "continue") this.#phase = "ended"
            }),
          ),
          Effect.provideService(Scheduler.PreventSchedulerYield, true),
        )
        if (settlement === "continue") continue
        const restart = interrupted && settlement === "settled" && holding
        const result = settlement === "settled" ? end : settledAs[settlement]
        const details = report(result)
        return { result, details: Exit.isSuccess(exit) ? Effect.interruptible(details) : details, interrupted, restart }
      }
    })
    // Mask the driver before its first turn. Only the work between settlement boundaries is interruptible.
    const publish = Effect.gen({ self: this }, function* () {
      const { result, details, interrupted, restart } = yield* finish
      const brief = ({ status, reason }: End): RunOutcome => ({
        threadId,
        flowId: this.flowId,
        steps: this.steps,
        status,
        reason,
        trace: [],
        modelCalls: [],
      })
      const outcome = interrupted
        ? brief(result)
        : yield* details.pipe(
            Effect.catchCauseIf(Cause.hasInterruptsOnly, () => {
              this.#abort.abort()
              return Effect.succeed(brief(result))
            }),
          )
      if (restart) this.#successor = yield* resume
      return outcome
    }).pipe(
      Effect.onExit((exit) => {
        remove()
        return Deferred.done(this.#done, exit)
      }),
    )
    return Effect.map(Effect.forkIn(publish, scope, { uninterruptible: true }), (fiber) => {
      this.#fiber = fiber
      if (this.#phase === "holding" || this.#phase === "dropping") fiber.interruptUnsafe()
    })
  }
}
