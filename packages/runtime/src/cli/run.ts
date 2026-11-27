import type { Message } from "@standardagents/spec"
import { Console, Duration, Effect, Option, Queue } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Interrupts } from "#platform"
import { toolCallsOf } from "../execution/assemble.ts"
import { HookTimeout } from "../execution/hooks.ts"
import type { ExecutionEvent } from "../execution/step.ts"
import { ThreadSupervisor } from "../execution/ThreadSupervisor.ts"
import { formatTraceEntry } from "../execution/trace.ts"
import { createThread } from "../execution/trigger.ts"
import { deliveryFlags, fail, note, plural, requestText, toolCallLine, withOutput, withProject } from "./shared.ts"

const stillQueued = "Your message is still queued and the next run of this thread will deliver it."

const printer =
  (modelRole: Message["role"], options: { readonly trace: boolean; readonly dumpRequests: boolean }) =>
  (event: ExecutionEvent): Effect.Effect<void> => {
    const print = (line: string) => Console.log(line)
    if (event.type === "trace") return options.trace ? print(formatTraceEntry(event.entry)) : Effect.void
    if (event.type === "request") {
      if (!options.dumpRequests) return Effect.void
      return print(requestText(event.request))
    }
    const message = event.message
    if (message.role === "tool")
      return print(`[tool result] ${message.name} ${message.tool_status}: ${message.content ?? ""}`)
    if (message.role !== modelRole) return Effect.void
    return Effect.gen(function* () {
      if (message.content !== null && message.content !== "") yield* print(message.content)
      for (const call of toolCallsOf(message)) yield* print(toolCallLine(call))
    })
  }

interface DeliveryArgs {
  readonly message: string
  readonly dir: string
  readonly script: Option.Option<string>
  readonly trace: boolean
  readonly dumpRequests: boolean
  readonly db: string
  readonly hookTimeout: Option.Option<number>
}

export const deliver = (args: DeliveryArgs, target: { readonly agent: string } | { readonly thread: string }) =>
  withOutput(({ secrets, clean, identify }) => {
    if (Option.isSome(args.hookTimeout) && !(args.hookTimeout.value > 0))
      return fail("--hook-timeout takes a number of seconds above 0")
    const run = withProject(
      args.dir,
      args.db,
      target,
      args.script,
      secrets,
      (_, filename) =>
        Effect.gen(function* () {
          const threadId = "agent" in target ? (yield* createThread(target.agent, secrets)).id : target.thread
          // Another command can name a thread in a database file, so the id comes first, before any reply.
          if (filename !== ":memory:") yield* identify(`thread ${threadId}`)
          const supervisor = yield* ThreadSupervisor
          const send = supervisor.send(threadId, args.message, {
            onWaiting: (holder) =>
              holder.kind === "remote"
                ? identify(`thread ${threadId} is running in process ${holder.pid}, so the message waits in its queue`)
                : Effect.void,
            interruptedWhileQueued: note(stillQueued),
          })

          const delivery = yield* Effect.raceFirst(answerInterrupts(supervisor, threadId, identify), send)
          const { outcome } = delivery
          const queuedNote = delivery.stillQueued ? `. ${stillQueued}` : ""
          if (outcome !== undefined) {
            if (outcome.reason === "execution_lost")
              return yield* fail(
                `lost thread ${threadId}: another process recovered it by force, so this process stopped working on it${queuedNote}`,
                identify,
              )
            yield* identify(
              `${outcome.status} (${clean(outcome.reason)}) after ${plural(outcome.steps, "step")}, thread ${threadId}`,
            )
            if (outcome.status === "failed") return yield* fail(outcome.error?.message ?? outcome.reason)
            return
          }
          const { status } = delivery
          yield* identify(`${status.state} (${clean(status.reason ?? "none")}), thread ${threadId}`)
          if (status.state === "failed")
            return yield* fail(
              `the run of thread ${threadId} ended ${clean(status.reason ?? "none")}${queuedNote}`,
              identify,
            )
        }),
      (role) => printer(role, args),
    )
    return Option.isSome(args.hookTimeout)
      ? run.pipe(Effect.provideService(HookTimeout, Duration.millis(args.hookTimeout.value * 1000)))
      : run
  })

// The first Ctrl-C asks the execution to stop after its current operation. The second interrupts it, and the run
// settles idle while the thread stays open. A Ctrl-C after that ends the process.
const answerInterrupts = (supervisor: ThreadSupervisor["Service"], threadId: string, identify: typeof note) =>
  Effect.gen(function* () {
    const take = Queue.take(yield* (yield* Interrupts).listen)
    yield* take
    if (!(yield* supervisor.stop(threadId))) return yield* Effect.interrupt
    yield* identify(`stopping thread ${threadId} after its current operation. Press Ctrl-C again to abort it.`)
    yield* take
    if (!(yield* supervisor.abort(threadId, true))) return yield* Effect.interrupt
  }).pipe(Effect.scoped, Effect.andThen(identify(`aborting thread ${threadId}`)), Effect.andThen(Effect.never))

export const runCommand = Command.make(
  "run",
  {
    agent: Argument.String("agent").pipe(Argument.withDescription("The agent whose prompt side answers")),
    ...deliveryFlags,
    db: Flag.String("db").pipe(
      Flag.withDescription("The SQLite database file. Without it the thread lives in memory and ends with the run."),
      Flag.withDefault(":memory:"),
    ),
  },
  (args) => deliver(args, { agent: args.agent }),
).pipe(Command.withDescription("Send one message to an agent and print the reply of its prompt side"))
