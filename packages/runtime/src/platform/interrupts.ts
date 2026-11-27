import { EventEmitter } from "node:events"
import { Context, Effect, Queue, Runtime, type Scope } from "effect"

const listen = (signals: EventEmitter): Effect.Effect<Queue.Dequeue<void>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<void>()
    const offer = () => Queue.offerUnsafe(queue, undefined)
    yield* Effect.acquireRelease(
      Effect.sync(() => signals.on("SIGINT", offer)),
      () => Effect.sync(() => signals.off("SIGINT", offer)),
    )
    return queue
  })

export const Interrupts = Context.Reference("spindle/Interrupts", { defaultValue: () => ({ listen: listen(process) }) })

export const runMain = <A, E>(effect: Effect.Effect<A, E>) => {
  const keyboard = new EventEmitter()
  Runtime.makeRunMain(({ fiber, teardown }) => {
    const onSignal = (signal: string) => {
      if (signal !== "SIGINT" || !keyboard.emit(signal)) fiber.interruptUnsafe(fiber.id)
    }
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const
    for (const signal of signals) process.on(signal, onSignal)
    fiber.addObserver((exit) => {
      for (const signal of signals) process.off(signal, onSignal)
      teardown(exit, (code) => {
        // An abandoned tool may keep a timer alive. Flush the exit lines before ending the process.
        process.stdout.write("", () => process.stderr.write("", () => process.exit(code)))
      })
    })
  })(Effect.provideService(effect, Interrupts, { listen: listen(keyboard) }))
}
