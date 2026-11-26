import type { Message } from "@standardagents/spec"
import { Cause, Console, Effect, Exit, Fiber, FileSystem, Layer, Logger, Option, Path, Queue, Semaphore } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { onInterrupt, openChatTerminal } from "#platform"
import { toolCallsOf } from "../execution/assemble.ts"
import { newSecrets } from "../execution/env.ts"
import { redactor } from "../execution/redact.ts"
import { type ExecutionEvent, learnSecrets } from "../execution/step.ts"
import { type Delivery, layer as supervisorLayer, ThreadSupervisor } from "../execution/ThreadSupervisor.ts"
import { formatTraceEntry } from "../execution/trace.ts"
import { createThread } from "../execution/trigger.ts"
import { prepareTurn, roleOf, sidesOf } from "../execution/turn.ts"
import { decodeScript, scriptedProvider } from "../providers/script.ts"
import { Registry } from "../registry/Registry.ts"
import { validate } from "../registry/validate.ts"
import { ThreadStore, ThreadTerminated } from "../store/ThreadStore.ts"
import { deliveryFlags, fail, openDatabase, operatorNotes, RunFailed } from "./run.ts"

const shellWord = (word: string) =>
  /^[a-zA-Z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

const escapeControls = (text: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: keep model and tool text from driving the terminal
  text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)

const note = (text: string) => Console.error(`spindle: ${text}`)
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))

const messageLines = (message: Message, modelRole: Message["role"], own: boolean) => {
  if (message.silent || own) return []
  const content = message.content ?? ""
  if (message.role === "tool")
    return [`[tool result] ${message.name} ${message.tool_status === "success" ? "ok" : `error: ${content}`}`]
  if (message.role === modelRole)
    return [
      ...(content ? [content] : []),
      ...toolCallsOf(message).map((call) => `[tool call] ${call.name} ${JSON.stringify(call.arguments)}`),
    ]
  return message.role === "user" || message.role === "assistant" ? [`[elsewhere] ${content}`] : []
}

const report = (delivery: Delivery) =>
  Effect.gen(function* () {
    const { outcome, status } = delivery
    const state = outcome?.status ?? status.state
    const reason = outcome?.reason ?? status.reason ?? "none"
    if (state === "failed" && outcome?.error) {
      const { origin, message } = outcome.error
      yield* note(`${origin?.startsWith("provider:") ? "provider error" : "error"}: ${message}`)
    }
    if (reason !== "stop_on_response") yield* note(`${state} (${reason})`)
  })

const readScript = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const json = yield* fs
      .readFileString(file)
      .pipe(Effect.catch((error) => fail(`cannot read the script ${file}: ${error.message}`)))
    return scriptedProvider(
      yield* decodeScript(json).pipe(
        Effect.catch((error) => fail(`${file} is not a valid script: ${error.message.replaceAll(/\s*\n\s*/g, " ")}`)),
      ),
    )
  })

const openThread = (
  agent: string,
  filename: string,
  requested: Option.Option<string>,
  secrets: Set<string>,
  identify: ReturnType<typeof operatorNotes>,
  clean: (text: string) => string,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    if (Option.isNone(requested)) {
      const { id } = yield* createThread(agent, secrets)
      yield* identify(`thread ${id}`)
      if (filename === ":memory:") yield* note("no --db, so the thread lives in memory and ends with this chat")
      return { id, cursor: 0 }
    }
    const id = requested.value
    const opened = yield* store.transaction(
      Effect.gen(function* () {
        const thread = yield* store
          .getThread(id)
          .pipe(Effect.catchTag("ThreadNotFound", () => fail(`no thread ${id} in ${filename}`)))
        if (thread.agentId !== agent)
          return yield* Effect.andThen(
            identify(`thread ${id} belongs to agent ${clean(thread.agentId)}, not ${clean(agent)}`),
            Effect.fail(new RunFailed({ message: "wrong agent" })),
          )
        if (thread.terminated !== null)
          return yield* new ThreadTerminated({ threadId: id, terminated: thread.terminated })
        yield* store.recover(id)
        const { status } = yield* store.getThread(id)
        const holder = yield* store.holderOf(id)
        return { status, holder, cursor: yield* store.latestMessageSeq(id) }
      }),
    )
    yield* identify(`thread ${id}`)
    yield* note(
      opened.holder
        ? `running in process ${opened.holder.pid}, so a line you type waits in its queue`
        : `${opened.status.state} (${opened.status.reason ?? "none"})`,
    )
    return { id, cursor: opened.cursor }
  })

type Ending = "input" | "closed" | "terminated"
type Turn = Fiber.Fiber<Delivery, unknown>

interface Conversation {
  readonly id: string
  readonly cursor: number
  readonly role: Message["role"]
  readonly onAdmitted: (seq: number) => void
  readonly identify: ReturnType<typeof operatorNotes>
  readonly clean: (text: string) => string
  readonly trace: boolean
  readonly dumpRequests: boolean
}

const converse = (chat: Conversation) =>
  Effect.gen(function* () {
    const terminal = yield* openChatTerminal
    const store = yield* ThreadStore
    const supervisor = yield* ThreadSupervisor
    const interrupts = yield* Queue.make<void>()
    yield* Effect.acquireRelease(
      Effect.sync(() => onInterrupt(() => Queue.offerUnsafe(interrupts, undefined))),
      (remove) => Effect.sync(remove),
    )
    const interrupt = Effect.as(Queue.take(interrupts), { kind: "interrupt" } as const)
    const closed = Effect.as(terminal.outputClosed, { kind: "closed" } as const)
    const write = (text: string) => terminal.write(chat.clean(text))
    const own = new Set<number>()
    let cursor = chat.cursor
    const output = yield* Semaphore.make(1)
    const flush = output.withPermit(
      Effect.gen(function* () {
        for (const row of yield* store.messagesAfter(chat.id, cursor)) {
          const sent = row.admission !== null && own.delete(row.admission)
          for (const line of messageLines(row.message, chat.role, sent)) {
            const text = chat.clean(line)
            yield* terminal.write(`${row.message.role === "tool" ? text.replaceAll("\n", " ") : text}\n`)
          }
          cursor = row.seq
        }
      }),
    )
    yield* flush
    let previous: Turn | undefined
    let waiting = false
    let atPrompt = true
    const finishPrevious = Effect.gen(function* () {
      if (!previous) return
      const turn = previous
      previous = undefined
      const delivery = yield* Fiber.join(turn)
      yield* flush
      yield* report(delivery)
    })
    const observe = (event: ExecutionEvent) =>
      Effect.gen(function* () {
        if (atPrompt || event.type === "queued") return
        waiting = false
        yield* finishPrevious
        if (event.type === "message") yield* flush
        if (event.type === "trace" && chat.trace) yield* write(`${formatTraceEntry(event.entry)}\n`)
        if (event.type === "request" && chat.dumpRequests) {
          const { signal: _, ...request } = event.request
          yield* write(`${JSON.stringify(request, null, 2)}\n`)
        }
      }).pipe(Effect.orDie)

    const prompt = Effect.gen(function* () {
      atPrompt = true
      yield* write("> ")
      return yield* Effect.raceAllFirst([
        closed,
        interrupt,
        Effect.map(terminal.readLine, (line) => ({ kind: "line", line }) as const),
      ])
    })
    const send = (line: string, onAdmitted: () => void) =>
      supervisor.send(chat.id, line, {
        observe,
        onAdmitted: (seq) => {
          onAdmitted()
          own.add(seq)
          chat.onAdmitted(seq)
        },
        onWaiting: (holder) =>
          Effect.gen(function* () {
            waiting = true
            // A remote holder cannot call our observer. Read its committed records until this send finishes.
            yield* Effect.forkChild(
              Effect.forever(
                Effect.andThen(
                  Effect.sleep("50 millis"),
                  Effect.suspend(() => (waiting && !atPrompt ? flush : Effect.void)),
                ),
              ),
            )
            yield* chat.identify(
              holder.abortedTool
                ? `tool ${chat.clean(holder.abortedTool)} has not returned since the abort, so the line waits in the queue until it does`
                : `thread ${chat.id} is running in process ${holder.pid}, so the line waits in its queue`,
            )
          }),
      })

    const waitForTurn = (turn: Turn, wasAdmitted: () => boolean) =>
      Effect.gen(function* () {
        let stopping = false
        const done = Effect.map(Fiber.await(turn), (exit) => ({ kind: "done", exit }) as const)
        while (true) {
          const event = yield* Effect.raceAllFirst([closed, interrupt, done])
          if (event.kind === "done") {
            if (Exit.isSuccess(event.exit)) {
              yield* finishPrevious
              yield* flush
              yield* report(event.exit.value)
              return "continue" as const
            }
            const error = Cause.squash(event.exit.cause)
            if (error instanceof ThreadTerminated) {
              yield* chat.identify(error.message)
              return "terminated" as const
            }
            const problem = wasAdmitted() ? "the line was sent, but the run could not finish" : "the line was not sent"
            yield* note(`${problem}: ${describe(error)}`)
            return "continue" as const
          }
          if (event.kind === "closed") {
            if (!waiting && (yield* supervisor.stop(chat.id))) yield* Fiber.await(turn)
            return "closed" as const
          }
          if (waiting || !(yield* supervisor.stop(chat.id))) return "input" as const
          if (stopping) {
            atPrompt = true
            yield* note("aborting the run")
            yield* supervisor.abort(chat.id)
            previous = turn
            return "continue" as const
          }
          stopping = true
          yield* note("stopping after the current operation. Press Ctrl-C again to abort.")
        }
      })

    let ending: Ending = "input"
    while (true) {
      const read = yield* prompt
      if (read.kind === "closed") {
        ending = "closed"
        break
      }
      if (read.kind === "interrupt" || read.line === null) break
      if (!terminal.isTerminal) yield* write(`${read.line}\n`)
      if (read.line.trim() === "") continue
      atPrompt = false
      if (previous?.pollUnsafe()) yield* finishPrevious
      yield* flush
      waiting = false
      let admitted = false
      const turn = yield* Effect.forkScoped(
        send(read.line, () => {
          admitted = true
        }),
      )
      const result = yield* waitForTurn(turn, () => admitted)
      if (result !== "continue") {
        ending = result
        break
      }
    }
    atPrompt = true
    if (ending === "input") yield* write("\n")
    if (yield* terminal.isOutputClosed) ending = "closed"
    if (ending === "closed") yield* note("standard output is closed")
    return ending
  })

export const chatCommand = Command.make(
  "chat",
  {
    agent: Argument.String("agent"),
    dir: Flag.String("dir").pipe(Flag.optional),
    db: Flag.String("db").pipe(Flag.optional),
    thread: Flag.String("thread").pipe(Flag.optional),
    script: deliveryFlags.script,
    trace: deliveryFlags.trace,
    dumpRequests: deliveryFlags.dumpRequests,
  },
  (args) =>
    Console.consoleWith((current) => {
      const secrets = new Set<string>()
      const identify = operatorNotes(current)
      const redact = redactor(secrets)
      const clean = (text: string) => escapeControls(redact(text))
      const console = Object.assign(Object.create(current) as Console.Console, {
        error: (...parts: ReadonlyArray<unknown>) => current.error(clean(parts.join(" "))),
      })
      const logger = Logger.make((entry) =>
        console.error(`spindle: ${Array.isArray(entry.message) ? entry.message.join(" ") : entry.message}`),
      )
      return Effect.gen(function* () {
        const path = yield* Path.Path
        const fs = yield* FileSystem.FileSystem
        const root = path.resolve(Option.getOrElse(args.dir, () => "."))
        const db = Option.getOrElse(args.db, () => ":memory:")
        const filename = db === ":memory:" ? db : path.resolve(db)
        return yield* Effect.gen(function* () {
          yield* prepareTurn(args.agent).pipe(
            Effect.flatMap((turn) => learnSecrets(turn, newSecrets(secrets))),
            Effect.ignore,
          )
          if (Option.isSome(args.thread) && filename === ":memory:") return yield* fail("--thread needs --db")
          const { issues } = yield* validate
          const errors = issues.filter((issue) => issue.severity === "error")
          for (const issue of errors)
            yield* Console.error(
              `${issue.code} ${issue.file}${issue.path === "" ? "" : `:${issue.path}`} ${issue.message}`,
            )
          if (errors.length)
            return yield* fail(`${root} has ${errors.length} definition error${errors.length === 1 ? "" : "s"}`)
          const { side } = yield* sidesOf(args.agent)
          const provider = Option.isSome(args.script) ? yield* readScript(path.resolve(args.script.value)) : undefined
          const database = yield* openDatabase(filename)
          const supervisor = supervisorLayer({ secrets, ...(provider ? { provider } : {}) })
          // A second Ctrl-C or a SIGTERM that lands after the conversation ends must not cut off the exit lines.
          yield* Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const thread = yield* restore(openThread(args.agent, filename, args.thread, secrets, identify, clean))
              let lastAdmission: number | undefined
              const conversation = yield* Effect.exit(
                restore(
                  converse({
                    ...thread,
                    role: roleOf(side),
                    identify,
                    onAdmitted: (seq) => {
                      lastAdmission = seq
                    },
                    clean,
                    trace: args.trace,
                    dumpRequests: args.dumpRequests,
                  }).pipe(Effect.scoped),
                ),
              )
              // A conversation that a signal or an error ended still says how to resume the thread.
              const ending = Exit.isSuccess(conversation) ? conversation.value : "input"
              if (ending === "terminated") return yield* new RunFailed({ message: ending })
              const store = yield* ThreadStore
              if (lastAdmission !== undefined && (yield* store.isQueued(thread.id, lastAdmission)))
                yield* note("your last line is still queued, and the next run of the thread delivers it")
              if (filename !== ":memory:") {
                if (!(yield* fs.exists(filename))) return yield* fail(`the database ${db} is gone`)
                const stored = yield* store.getThread(thread.id)
                if (stored.terminated === null) {
                  const dir = Option.isSome(args.dir) ? ` --dir ${shellWord(clean(args.dir.value))}` : ""
                  yield* identify(
                    `resume with spindle chat ${shellWord(clean(args.agent))} --thread ${shellWord(thread.id)} --db ${shellWord(clean(db))}${dir}`,
                  )
                }
              }
              if (Exit.isFailure(conversation)) return yield* Effect.failCause(conversation.cause)
              if (ending === "closed") return yield* new RunFailed({ message: ending })
            }),
          ).pipe(Effect.provide(Layer.provideMerge(supervisor, database)))
        }).pipe(Effect.provide(Registry.layer(root)))
      }).pipe(
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause)
          if (error instanceof ThreadTerminated)
            return Effect.andThen(identify(error.message), Effect.fail(new RunFailed({ message: error.message })))
          return error instanceof RunFailed || Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : fail(describe(error))
        }),
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(Console.Console, console),
      )
    }),
).pipe(Command.withDescription("Chat with an agent on one thread until end of input or Ctrl-C"))
