import { Console, Effect, Option, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { RunStore } from "../store/RunStore.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import { commandErrors, fail, openDatabase } from "./shared.ts"

const time = (micros: number) =>
  micros === 0 ? "0" : `${new Date(Math.floor(micros / 1000)).toISOString()} (${micros})`

// Execution State section 4: the run status, read the way any process reads it. A thread whose process is gone is settled as lost first. The command prints codes, times, and counts, and no text that a thread holds.
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
      const database = openDatabase(filename)
      yield* Effect.gen(function* () {
        const runStore = yield* RunStore
        const threadStore = yield* ThreadStore
        yield* runStore.recoverLost(args.thread)
        const thread = yield* threadStore
          .getThread(args.thread)
          .pipe(Effect.catchTag("ThreadNotFound", () => fail(`no thread ${args.thread} in ${filename}`)))
        const { state, since, reason } = thread.status
        yield* Console.log(`${state} ${reason ?? "none"} since ${time(since)}`)
        const holder = yield* runStore.holderOf(thread.id)
        if (holder !== null) yield* Console.log(`held by process ${holder.pid}`)
        yield* Console.log(`queued ${yield* runStore.queueLength(thread.id)}`)
        for (const failed of yield* runStore.failedDeliveries(thread.id))
          yield* Console.log(`failed delivery ${failed.seq} ${failed.kind} queued ${time(failed.queued_at)}`)
        if (thread.terminated !== null) yield* Console.log(`terminated ${time(thread.terminated)}`)
      }).pipe(Effect.provide(database))
    }).pipe(commandErrors()),
).pipe(Command.withDescription("Print a thread's run status: idle, running, or failed, with the reason and the time"))

export const recoverCommand = Command.make(
  "recover",
  {
    thread: Argument.String("thread").pipe(Argument.withDescription("The id of the thread to recover")),
    db: Flag.String("db").pipe(Flag.withDescription("The SQLite database file that holds the thread")),
    discardFailed: Flag.String("discard-failed").pipe(
      Flag.withDescription("Remove only the failed queue entry with this sequence number, without settling the run"),
      Flag.optional,
    ),
    force: Flag.Boolean("force").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Recover even when the holder process appears alive"),
    ),
  },
  ({ thread, db, force, discardFailed }) =>
    Effect.gen(function* () {
      const store = yield* RunStore
      if (Option.isSome(discardFailed)) {
        if (!/^-?[0-9]+$/.test(discardFailed.value))
          return yield* fail("--discard-failed takes an integer sequence number")
        const seq = BigInt(discardFailed.value).toString()
        const kind = yield* store
          .discardFailed(thread, seq)
          .pipe(Effect.catchTag("ThreadTerminated", () => fail(`thread ${thread} is terminated, so its queue is kept`)))
        if (kind === undefined) return yield* fail(`thread ${thread} has no failed delivery ${seq}`)
        return yield* Console.log(`thread ${thread}: removed failed delivery ${seq} (${kind}). Nothing else changed.`)
      }
      const result = yield* store.recoverThread(thread, force)
      if (result.kind === "atRest")
        return yield* Console.log(
          `thread ${thread} is not running (${result.thread.status.state} ${result.thread.status.reason ?? "none"}). Nothing changed.`,
        )
      if (result.kind === "alive")
        return yield* Console.log(
          `thread ${thread} is running in process ${result.pid}, which is alive. Nothing changed. Run again with --force to settle the thread as failed (execution_lost).`,
        )
      if (result.kind === "missingHolder")
        return yield* Console.log(`thread ${thread} had no recorded holder. Settled it as failed (execution_lost).`)
      const line = force
        ? `thread ${thread} was running in process ${result.pid}. Settled it as failed (execution_lost). That process can write nothing more to the thread.`
        : `thread ${thread} was running in process ${result.pid}, which is gone. Settled it as failed (execution_lost).`
      yield* Console.log(line)
    }).pipe(
      Effect.provide(openDatabase(db)),
      Effect.catchTag("ThreadNotFound", () => fail(`no thread ${thread} in ${db}`)),
      commandErrors(),
    ),
).pipe(Command.withDescription("Settle a thread whose execution was lost"))
