import { Cause, Console, Effect, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { ThreadStore } from "../store/ThreadStore.ts"
import { fail, openDatabase, RunFailed } from "./run.ts"

const time = (micros: number) =>
  micros === 0 ? "0" : `${new Date(Math.floor(micros / 1000)).toISOString()} (${micros})`

// Execution State section 4: the run status, read the way any process reads it. A thread whose holder's lease has
// expired is settled as lost first. The command prints codes, times, and counts, and no text that a thread holds.
export const statusCommand = Command.make(
  "status",
  {
    thread: Argument.String("thread").pipe(Argument.withDescription("The id of the thread that spindle run printed")),
    db: Flag.String("db").pipe(Flag.withDescription("The SQLite database file that holds the thread")),
  },
  (args) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const filename = path.resolve(args.db)
      const database = yield* openDatabase(filename)
      yield* Effect.gen(function* () {
        const store = yield* ThreadStore
        yield* store.recover(args.thread)
        const thread = yield* store
          .getThread(args.thread)
          .pipe(Effect.catchTag("ThreadNotFound", () => fail(`no thread ${args.thread} in ${filename}`)))
        const { state, since, reason } = thread.status
        yield* Console.log(`${state} ${reason ?? "none"} since ${time(since)}`)
        const holder = yield* store.holderOf(thread.id)
        if (holder !== null) yield* Console.log(`held by process ${holder.pid}, lease until ${time(holder.expiresAt)}`)
        yield* Console.log(`queued ${yield* store.queueLength(thread.id)}`)
        if (thread.terminated !== null) yield* Console.log(`terminated ${time(thread.terminated)}`)
      }).pipe(Effect.provide(database))
    }).pipe(
      Effect.catchCause((cause) => {
        const failure = Cause.findError(cause)
        if (failure._tag === "Success" && failure.success instanceof RunFailed) return Effect.failCause(cause)
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        const error = Cause.squash(cause)
        return fail(error instanceof Error ? error.message : String(error))
      }),
    ),
).pipe(Command.withDescription("Print a thread's run status: idle, running, or failed, with the reason and the time"))
