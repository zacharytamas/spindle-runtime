import type { LLMProviderInterface, Message } from "@standardagents/spec"
import { Cause, Console, Data, Effect, FileSystem, Layer, Option, Path, Runtime } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { SqliteLive } from "#platform"
import { toolCallsOf } from "../execution/assemble.ts"
import type { ExecutionEvent } from "../execution/step.ts"
import { formatTraceEntry } from "../execution/trace.ts"
import { sendMessage } from "../execution/trigger.ts"
import { roleOf, sidesOf } from "../execution/turn.ts"
import { decodeScript, scriptedProvider } from "../providers/script.ts"
import { Registry } from "../registry/Registry.ts"
import { validate } from "../registry/validate.ts"
import { layer as sqliteStore } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"

export class RunFailed extends Data.TaggedError("RunFailed")<{ readonly message: string }> {
  // runMain logs a failure and its stack unless this is false. The run already printed a plain message.
  override readonly [Runtime.errorReported] = false
}

const fail = (message: string) =>
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

const printer =
  (modelRole: Message["role"], options: { readonly trace: boolean; readonly dumpRequests: boolean }) =>
  (event: ExecutionEvent): Effect.Effect<void> => {
    if (event.type === "trace") return options.trace ? Console.log(formatTraceEntry(event.entry)) : Effect.void
    if (event.type === "request") {
      if (!options.dumpRequests) return Effect.void
      const { signal: _, ...request } = event.request
      return Console.log(JSON.stringify(request, null, 2))
    }
    const message = event.message
    if (message.role === "tool")
      return Console.log(`[tool result] ${message.name} ${message.tool_status}: ${message.content ?? ""}`)
    if (message.role !== modelRole) return Effect.void
    return Effect.gen(function* () {
      if (message.content !== null && message.content !== "") yield* Console.log(message.content)
      for (const call of toolCallsOf(message))
        yield* Console.log(`[tool call] ${call.name} ${JSON.stringify(call.arguments)}`)
    })
  }

const describe = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

export const runCommand = Command.make(
  "run",
  {
    agent: Argument.String("agent").pipe(Argument.withDescription("The agent whose prompt side answers")),
    message: Flag.String("message").pipe(
      Flag.withAlias("m"),
      Flag.withDescription("The message from the human side that starts the run"),
    ),
    dir: Flag.String("dir").pipe(
      Flag.withDescription("The project directory that holds agents/"),
      Flag.withDefault("."),
    ),
    script: Flag.String("script").pipe(
      Flag.withDescription("Answer from a JSON script of responses instead of calling the model's provider"),
      Flag.optional,
    ),
    trace: Flag.Boolean("trace").pipe(Flag.withDescription("Print each phase of each step"), Flag.withDefault(false)),
    dumpRequests: Flag.Boolean("dump-requests").pipe(
      Flag.withDescription("Print each provider request as JSON, with secret values redacted"),
      Flag.withDefault(false),
    ),
    db: Flag.String("db").pipe(
      Flag.withDescription("The SQLite database file. Without it the thread lives in memory and ends with the run."),
      Flag.withDefault(":memory:"),
    ),
  },
  (args) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const root = path.resolve(args.dir)
      const provider: LLMProviderInterface | undefined = Option.isSome(args.script)
        ? yield* loadScript(path.resolve(args.script.value))
        : undefined
      yield* Effect.gen(function* () {
        const { issues } = yield* validate
        const errors = issues.filter((issue) => issue.severity === "error")
        for (const issue of errors)
          yield* Console.error(
            `${issue.code} ${issue.file}${issue.path === "" ? "" : `:${issue.path}`} ${issue.message}`,
          )
        if (errors.length > 0)
          return yield* fail(`${root} has ${errors.length} definition error${errors.length === 1 ? "" : "s"}`)
        const sides = yield* sidesOf(args.agent).pipe(Effect.catchTag("SetupError", (error) => fail(error.message)))
        const filename = args.db === ":memory:" ? args.db : path.resolve(args.db)
        yield* Effect.gen(function* () {
          const store = yield* ThreadStore
          const thread = yield* store.createThread({ agentId: args.agent })
          const outcome = yield* sendMessage(thread.id, args.message, {
            ...(provider === undefined ? {} : { provider }),
            observe: printer(roleOf(sides.side), args),
          })
          yield* Console.error(
            `spindle: ${outcome.status} (${outcome.reason}) after ${outcome.steps} step${outcome.steps === 1 ? "" : "s"}, thread ${thread.id}`,
          )
          if (outcome.status === "failed") return yield* fail(outcome.error?.message ?? outcome.reason)
        }).pipe(Effect.provide(Layer.provide(sqliteStore, SqliteLive({ filename }))))
      }).pipe(Effect.provide(Registry.layer(root)))
    }).pipe(
      Effect.catchCause((cause) => {
        const failure = Cause.findError(cause)
        if (failure._tag === "Success" && failure.success instanceof RunFailed) return Effect.failCause(cause)
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        return fail(describe(cause))
      }),
    ),
).pipe(Command.withDescription("Send one message to an agent and print the reply of its prompt side"))
