import { Clock, Duration, Effect, Fiber, Option, type Scope } from "effect"

export class Callback {
  #finished = false
  #expired = false
  #overdue: (() => boolean) | undefined
  #release: (() => void) | undefined

  get finished() {
    return this.#finished
  }
  get expired() {
    return this.#expired
  }

  get pastDeadline() {
    return this.#expired || this.#overdue?.() === true
  }

  within<A, E>(effect: Effect.Effect<A, E>, timeout: Duration.Duration, onTimeout: () => E, toolScope?: Scope.Scope) {
    const bounded = Effect.gen({ self: this }, function* () {
      const clock = yield* Clock.Clock
      const millis = Duration.toMillis(timeout)
      const work = Effect.asSome(Effect.result(effect))
      // Hooks keep their wall-clock overrun check. A tool also checks its elapsed time at each handle write.
      const now = toolScope
        ? () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6
        : () => clock.currentTimeMillisUnsafe()
      const started = now()
      const overdue = () => now() - started > millis
      if (toolScope) this.#overdue = overdue
      // Arm a tool's timer before execute can block and then return a pending promise.
      const timer = Effect.as(clock.sleep(timeout), Option.none())
      const result = yield* toolScope ? Effect.raceFirst(timer, work) : Effect.raceFirst(work, timer)
      this.#overdue = undefined
      if (Option.isNone(result) || overdue()) {
        this.expire()
        return yield* Effect.fail(onTimeout())
      }
      return yield* Effect.fromResult(result.value)
    })
    // The tool's execution scope outlives interruption of its step, so an abort can still wait for this deadline.
    return toolScope
      ? bounded.pipe(Effect.forkIn(toolScope, { startImmediately: true }), Effect.flatMap(Fiber.join))
      : bounded
  }

  private expire() {
    this.#expired = true
    this.#release?.()
    this.#release = undefined
  }

  invoke<A>(invoke: () => PromiseLike<A> | A, register?: () => () => void) {
    try {
      const value = invoke()
      if (!value || typeof (value as PromiseLike<A>).then !== "function") {
        this.#finished = true
        return Promise.resolve(value)
      }
      const result = Promise.resolve(value).finally(() => {
        this.#finished = true
        this.#release?.()
        this.#release = undefined
      })
      this.#release = register?.()
      return result
    } catch (error) {
      this.#finished = true
      throw error
    }
  }
}
