import { EventEmitter } from "node:events"
import { Context, Effect, Queue, Runtime } from "effect"

const listen = (signals: EventEmitter) =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<void>()
    const offer = () => Queue.offerUnsafe(queue, undefined)
    yield* Effect.acquireRelease(
      Effect.sync(() => signals.on("SIGINT", offer)),
      () => Effect.sync(() => signals.off("SIGINT", offer)),
    )
    return queue as Queue.Dequeue<void>
  })

export const Interrupts = Context.Reference("spindle/Interrupts", { defaultValue: () => ({ listen: listen(process) }) })

export const runMain = <A, E>(effect: Effect.Effect<A, E>) => {
  const keyboard = new EventEmitter()
  Runtime.makeRunMain(({ fiber, teardown }) => {
    const onSignal = (signal: string) => {
      if (signal !== "SIGINT" || !keyboard.emit(signal)) fiber.interruptUnsafe(fiber.id)
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, onSignal)
    fiber.addObserver((exit) => {
      teardown(exit, (code) => {
        // Keep the signal handlers installed until the exit lines reach both pipes.
        process.stdout.write("", () => process.stderr.write("", () => process.exit(code)))
      })
    })
  })(Effect.provideService(effect, Interrupts, { listen: listen(keyboard) }))
}
