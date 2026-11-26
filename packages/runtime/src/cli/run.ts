import type { LLMProviderInterface, Message } from "@standardagents/spec"
import { Cause, Console, Data, Duration, Effect, FileSystem, Layer, Logger, Option, Path, Runtime } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { onInterrupt, SqliteLive } from "#platform"
import { toolCallsOf } from "../execution/assemble.ts"
import { newSecrets } from "../execution/env.ts"
import { HookTimeout } from "../execution/hooks.ts"
import { redactor } from "../execution/redact.ts"
import { type ExecutionEvent, learnSecrets } from "../execution/step.ts"
import { HolderTimeout, layer as supervisorLayer, ThreadSupervisor } from "../execution/ThreadSupervisor.ts"
import { formatTraceEntry } from "../execution/trace.ts"
import { createThread, sendMessage } from "../execution/trigger.ts"
import { prepareTurn, roleOf, sidesOf } from "../execution/turn.ts"
import { decodeScript, scriptedProvider } from "../providers/script.ts"
import { Registry } from "../registry/Registry.ts"
import { validate } from "../registry/validate.ts"
import { layer as sqliteStore } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"

export class RunFailed extends Data.TaggedError("RunFailed")<{ readonly message: string }> {
  // runMain logs a failure and its stack unless this is false. The run already printed a plain message.
  override readonly [Runtime.errorReported] = false
}

export const fail = (message: string) =>
  Effect.gen(function* () {
    yield* Console.error(`spindle: ${message}`)
    return yield* new RunFailed({ message })
  })

const loadScript = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const text = yield* fs
      .readFileString(file)
      .pipe(Effect.catch((error) => fail(`cannot read the script ${file}: ${error.message}`)))
    const script = yield* decodeScript(text).pipe(
      Effect.catch((error) => fail(`${file} is not a valid script: ${error.message.replaceAll(/\s*\n\s*/g, " ")}`)),
    )
    return scriptedProvider(script)
  })

// Threads section 2.3 and Infrastructure Providers: the command prints no secret value. Every line it prints goes
// through one redactor, which knows each value the execution has resolved as secret by then.
const redacting = (console: Console.Console, redact: (text: string) => string): Console.Console => {
  const clean = (parts: ReadonlyArray<unknown>) => parts.map((part) => (typeof part === "string" ? redact(part) : part))
  return Object.assign(Object.create(console) as Console.Console, {
    log: (...parts: ReadonlyArray<unknown>) => console.log(...clean(parts)),
    error: (...parts: ReadonlyArray<unknown>) => console.error(...clean(parts)),
  })
}

const printer =
  (modelRole: Message["role"], options: { readonly trace: boolean; readonly dumpRequests: boolean }) =>
  (event: ExecutionEvent): Effect.Effect<void> => {
    const print = (line: string) => Console.log(line)
    if (event.type === "trace") return options.trace ? print(formatTraceEntry(event.entry)) : Effect.void
    if (event.type === "request") {
      if (!options.dumpRequests) return Effect.void
      const { signal: _, ...request } = event.request
      return print(JSON.stringify(request, null, 2))
    }
    const message = event.message
    if (message.role === "tool")
      return print(`[tool result] ${message.name} ${message.tool_status}: ${message.content ?? ""}`)
    if (message.role !== modelRole) return Effect.void
    return Effect.gen(function* () {
      if (message.content !== null && message.content !== "") yield* print(message.content)
      for (const call of toolCallsOf(message))
        yield* print(`[tool call] ${call.name} ${JSON.stringify(call.arguments)}`)
    })
  }

// SQLite says only that it cannot open the file, so the command names a missing directory or a directory first.
export const openDatabase = (filename: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const problem = (cause: string) => fail(`cannot open the database ${filename}: ${cause}`)
    if (filename !== ":memory:") {
      const info = yield* Effect.option(fs.stat(filename))
      if (Option.isSome(info) && info.value.type === "Directory") return yield* problem("it is a directory")
      const directory = path.dirname(filename)
      if (!(yield* fs.exists(directory))) return yield* problem(`the directory ${directory} does not exist`)
    }
    return Layer.provide(sqliteStore, SqliteLive({ filename })).pipe(
      Layer.catchTag("SqlError", (error) =>
        Layer.effect(
          ThreadStore,
          problem(error.cause.cause instanceof Error ? error.cause.cause.message : error.message),
        ),
      ),
    )
  })

const describe = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

// The flags that run and send share. Both deliver one message from the human side and print the run that takes it.
export const deliveryFlags = {
  message: Flag.String("message").pipe(Flag.withAlias("m"), Flag.withDescription("The message from the human side")),
  dir: Flag.String("dir").pipe(Flag.withDescription("The project directory that holds agents/"), Flag.withDefault(".")),
  script: Flag.String("script").pipe(
    Flag.withDescription("Answer from a JSON script of responses instead of calling the model's provider"),
    Flag.optional,
  ),
  trace: Flag.Boolean("trace").pipe(Flag.withDescription("Print each phase of each step"), Flag.withDefault(false)),
  dumpRequests: Flag.Boolean("dump-requests").pipe(
    Flag.withDescription("Print each provider request as JSON, with secret values redacted"),
    Flag.withDefault(false),
  ),
  hookTimeout: Flag.Finite("hook-timeout").pipe(
    Flag.withDescription("Seconds one hook call may run before the run goes on without it. The default is 30."),
    Flag.optional,
  ),
  holderTimeout: Flag.Finite("holder-timeout").pipe(
    Flag.withDescription(
      "Seconds that this process's claim on a running thread lasts without renewal. Another process counts this one as gone after that long. The default is 15.",
    ),
    Flag.optional,
  ),
}

export interface DeliveryArgs {
  readonly message: string
  readonly dir: string
  readonly script: Option.Option<string>
  readonly trace: boolean
  readonly dumpRequests: boolean
  readonly db: string
  readonly hookTimeout: Option.Option<number>
  readonly holderTimeout: Option.Option<number>
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

// Creates a thread for the agent, or sends to the thread that already exists, and prints the run that takes the message.
export const deliver = (args: DeliveryArgs, target: { readonly agent: string } | { readonly thread: string }) =>
  Console.consoleWith((current) => {
    const secrets = new Set<string>()
    const console = redacting(current, redactor(secrets))
    // A log line, such as a hook that failed, goes to standard error with the other notes, through the redactor.
    const logger = Logger.make((entry) => {
      const parts: ReadonlyArray<unknown> = Array.isArray(entry.message) ? entry.message : [entry.message]
      console.error(`spindle: ${parts.join(" ")}`)
    })
    return Effect.gen(function* () {
      const path = yield* Path.Path
      const root = path.resolve(args.dir)
      const filename = args.db === ":memory:" ? args.db : path.resolve(args.db)
      for (const [flag, value] of [
        ["--hook-timeout", args.hookTimeout],
        ["--holder-timeout", args.holderTimeout],
      ] as const)
        if (Option.isSome(value) && !(value.value > 0)) return yield* fail(`${flag} takes a number of seconds above 0`)
      // The thread names the agent that send runs, so send reads it before it validates the definitions.
      let agent: string
      let store: Layer.Layer<ThreadStore, unknown> | undefined
      if ("agent" in target) agent = target.agent
      else {
        const { thread } = target
        const opened = yield* openDatabase(filename)
        store = opened
        agent = yield* Effect.gen(function* () {
          const threads = yield* ThreadStore
          return (yield* threads.getThread(thread)).agentId
        }).pipe(
          Effect.provide(opened),
          Effect.catchTag("ThreadNotFound", () => fail(`no thread ${thread} in ${filename}`)),
        )
      }
      yield* Effect.gen(function* () {
        const { issues } = yield* validate
        // The redactor knows only what the execution has learned, so it learns the turn's secrets before the
        // command prints its first line. A turn that cannot be prepared fails again in the run with its own message.
        yield* prepareTurn(agent).pipe(
          Effect.flatMap((turn) => learnSecrets(turn, newSecrets(secrets))),
          Effect.ignore,
        )
        const errors = issues.filter((issue) => issue.severity === "error")
        for (const issue of errors)
          yield* Console.error(
            `${issue.code} ${issue.file}${issue.path === "" ? "" : `:${issue.path}`} ${issue.message}`,
          )
        if (errors.length > 0) return yield* fail(`${root} has ${plural(errors.length, "definition error")}`)
        const sides = yield* sidesOf(agent).pipe(Effect.catchTag("SetupError", (error) => fail(error.message)))
        const provider: LLMProviderInterface | undefined = Option.isSome(args.script)
          ? yield* loadScript(path.resolve(args.script.value))
          : undefined
        const database = store ?? (yield* openDatabase(filename))
        const options = {
          ...(provider === undefined ? {} : { provider }),
          secrets,
          observe: printer(roleOf(sides.side), args),
        }
        const supervisor = supervisorLayer(options).pipe(
          Layer.provide(
            Option.isSome(args.holderTimeout)
              ? Layer.succeed(HolderTimeout, Duration.millis(args.holderTimeout.value * 1000))
              : Layer.empty,
          ),
        )
        yield* Effect.gen(function* () {
          const threadId = "agent" in target ? (yield* createThread(target.agent)).id : target.thread
          // Another command can name a thread in a database file, so the id comes first, before any reply.
          if (filename !== ":memory:") yield* Console.error(`spindle: thread ${threadId}`)
          const delivery = yield* sendMessage(threadId, args.message, options).pipe(answerInterrupts(threadId))
          const { outcome } = delivery
          if (outcome !== undefined) {
            yield* Console.error(
              `spindle: ${outcome.status} (${outcome.reason}) after ${plural(outcome.steps, "step")}, thread ${threadId}`,
            )
            if (outcome.status === "failed") return yield* fail(outcome.error?.message ?? outcome.reason)
            return
          }
          const { status } = delivery
          yield* Console.error(`spindle: ${status.state} (${status.reason ?? "none"}), thread ${threadId}`)
          if (status.state === "failed") return yield* fail(`the run of thread ${threadId} ended ${status.reason}`)
        }).pipe(Effect.provide(Layer.provideMerge(supervisor, database)))
      }).pipe(Effect.provide(Registry.layer(root)))
    }).pipe(
      Effect.catchCause((cause) => {
        const failure = Cause.findError(cause)
        if (failure._tag === "Success" && failure.success instanceof RunFailed) return Effect.failCause(cause)
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        return fail(describe(cause))
      }),
      Effect.provide(Logger.layer([logger])),
      Option.isSome(args.hookTimeout)
        ? Effect.provideService(HookTimeout, Duration.millis(args.hookTimeout.value * 1000))
        : (effect) => effect,
      Effect.provideService(Console.Console, console),
    )
  })

// The first Ctrl-C asks the execution to stop after its current operation. The second interrupts it, and the run
// settles idle while the thread stays open. A Ctrl-C after that ends the process.
const answerInterrupts =
  (threadId: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | ThreadSupervisor> =>
    Effect.gen(function* () {
      const supervisor = yield* ThreadSupervisor
      const context = yield* Effect.context<never>()
      let presses = 0
      const remove = onInterrupt(() => {
        presses += 1
        const answer =
          presses === 1
            ? Console.error(
                `spindle: stopping thread ${threadId} after its current operation. Press Ctrl-C again to abort it.`,
              ).pipe(Effect.andThen(supervisor.stop(threadId)))
            : Console.error(`spindle: aborting thread ${threadId}`).pipe(
                Effect.andThen(Effect.sync(() => remove())),
                Effect.andThen(supervisor.abort(threadId)),
              )
        Effect.runForkWith(context)(answer)
      })
      return yield* Effect.ensuring(
        effect,
        Effect.sync(() => remove()),
      )
    })

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
