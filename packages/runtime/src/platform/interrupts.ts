import * as Runtime from "effect/Runtime"

const handlers: Array<() => void> = []

// A command that answers the keyboard interrupt itself registers a handler, and the last one registered gets SIGINT.
// With no handler, SIGINT and SIGTERM interrupt the main fiber, as the runners of the platform packages do.
export const onInterrupt = (handler: () => void): (() => void) => {
  handlers.push(handler)
  return () => {
    const index = handlers.lastIndexOf(handler)
    if (index !== -1) handlers.splice(index, 1)
  }
}

export const runMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  let receivedSignal = false
  const onSignal = (signal: string) => {
    const handler = signal === "SIGINT" ? handlers.at(-1) : undefined
    if (handler !== undefined) return handler()
    receivedSignal = true
    fiber.interruptUnsafe(fiber.id)
  }
  fiber.addObserver((exit) => {
    process.removeListener("SIGINT", onSignal)
    process.removeListener("SIGTERM", onSignal)
    teardown(exit, (code) => {
      if (receivedSignal || code !== 0) process.exit(code)
    })
  })
  process.on("SIGINT", onSignal)
  process.on("SIGTERM", onSignal)
})
