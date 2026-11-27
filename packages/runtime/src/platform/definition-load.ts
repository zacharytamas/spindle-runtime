import { AsyncLocalStorage } from "node:async_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { Context, Duration, Effect, Semaphore } from "effect"

type Read = <A, E>(file: string, load: () => Promise<A>, failure: (cause: unknown) => E) => Effect.Effect<A, E>
type Fault = { file: string; cause: unknown }

const read: Read = (_, load, failure) => Effect.tryPromise({ try: load, catch: failure })
const DefinitionLoad = Context.Reference<Read>("spindle/DefinitionLoad", { defaultValue: () => read })

export const readDefinition: Read = (file, load, failure) =>
  DefinitionLoad.use((evaluate) => evaluate(file, load, failure))

// Two commands in one process must restore the same exit function and own only their own listeners.
const lock = Semaphore.makeUnsafe(1)

const listen = (seconds: number) => {
  const source = new AsyncLocalStorage<string>()
  const faults: Array<Fault> = []
  const exits = new Map<unknown, string>()
  const exit = process.exit
  const currentFile = () => source.getStore() ?? "agents"
  const onError = (cause: unknown) => {
    const file = exits.get(cause) ?? currentFile()
    exits.delete(cause)
    faults.push({ file, cause })
  }

  process.on("uncaughtException", onError)
  process.on("unhandledRejection", onError)
  process.exit = (code) => {
    const error = new Error(`A definition called process.exit(${code ?? ""}) during loading`)
    exits.set(error, currentFile())
    throw error
  }

  const evaluate: Read = (file, load, failure) =>
    read(
      file,
      () => source.run(file, load),
      (cause) => {
        // A propagated exit goes through the ordinary loader diagnostic. A caught exit is still a load fault.
        exits.delete(cause)
        return failure(cause)
      },
    ).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(seconds),
        orElse: () => Effect.fail(failure(new Error(`Loading ${file} exceeded the ${seconds} second time limit`))),
      }),
    )
  const restore = () => {
    process.exit = exit
    process.off("unhandledRejection", onError)
    process.off("uncaughtException", onError)
    source.disable()
  }
  return { evaluate, restore, faults, exits }
}

// The faults are described before the exit function is restored, because describing a thrown value reads it.
export const isolateDefinitionLoads = <A, E, R>(
  seconds: number,
  load: Effect.Effect<A, E, R>,
  describe: (cause: unknown) => string,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => listen(seconds)),
    ({ evaluate, faults, exits }) =>
      Effect.gen(function* () {
        const value = yield* Effect.provideService(load, DefinitionLoad, evaluate)
        yield* Effect.promise(() => delay(0))
        for (const [cause, file] of exits) faults.push({ file, cause })
        return { value, faults: faults.map(({ file, cause }) => ({ file, reason: describe(cause) })) }
      }),
    ({ restore }) => Effect.sync(restore),
  ).pipe(Semaphore.withPermit(lock))
