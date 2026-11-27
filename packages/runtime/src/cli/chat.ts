import type { Message, ThreadStatus } from "@standardagents/spec"
import { Cause, Effect, Exit, Fiber, FileSystem, Option, Queue, Semaphore } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { onInterrupt, openChatTerminal } from "#platform"
import { toolCallsOf } from "../execution/assemble.ts"
import type { Execution } from "../execution/Execution.ts"
import type { ExecutionEvent, RunOutcome } from "../execution/step.ts"
import { type Delivery, ThreadSupervisor } from "../execution/ThreadSupervisor.ts"
import { formatTraceEntry } from "../execution/trace.ts"
import { createThread } from "../execution/trigger.ts"
import { MessageStore } from "../store/MessageStore.ts"
import { type Thread, ThreadTerminated } from "../store/model.ts"
import { RunStore } from "../store/RunStore.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import {
  CommandFailed,
  deliveryFlags,
  describe,
  fail,
  note,
  requestText,
  toolCallLine,
  withOutput,
  withProject,
} from "./shared.ts"

const shellWord = (word: string) =>
  /^[a-zA-Z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

const escapeControls = (text: string) =>
  text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: keep model and tool text from driving the terminal
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
    .replace(/\p{Bidi_Control}/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)

const messageLines = (message: Message, chat: Conversation, own: boolean) => {
  if (message.silent || own) return []
  const content = message.content ?? ""
  if (message.role === "tool") {
    const label = `[tool result] ${chat.clean(String(message.name))}`
    const text = chat.clean(content).replaceAll(/[\n\u2028\u2029]/g, " ")
    if (message.tool_status !== "success") return [`${label} error: ${text}`]
    if (!text) return [`${label} ok`]
    const preview = chat.fullResults ? text : text.replace(/^(.{200}).+$/su, "$1...")
    return [`${label} ok: ${preview}`]
  }
  if (message.role === chat.role)
    return [
      ...(content ? [chat.clean(content)] : []),
      ...toolCallsOf(message).map((call) => chat.clean(toolCallLine(call))),
    ]
  return message.role === "user" || message.role === "assistant" ? [chat.clean(`[elsewhere] ${content}`)] : []
}

const report = (result: RunOutcome | ThreadStatus) =>
  Effect.gen(function* () {
    const state = "state" in result ? result.state : result.status
    const reason = result.reason ?? "none"
    if (state === "failed" && "error" in result && result.error) {
      const { origin, message } = result.error
      yield* note(`${origin?.startsWith("provider:") ? "provider error" : "error"}: ${message}`)
    }
    if (reason !== "stop_on_response") yield* note(`${state} (${reason})`)
  })

const requireOpen = (thread: Thread) =>
  thread.terminated === null
    ? Effect.void
    : Effect.fail(new ThreadTerminated({ threadId: thread.id, terminated: thread.terminated }))

const openThread = (
  agent: string,
  filename: string,
  requested: Option.Option<string>,
  secrets: Set<string>,
  identify: typeof note,
  clean: (text: string) => string,
) =>
  Effect.gen(function* () {
    const threadStore = yield* ThreadStore
    const runStore = yield* RunStore
    const messageStore = yield* MessageStore
    if (Option.isNone(requested)) {
      const { id } = yield* createThread(agent, secrets)
      yield* identify(`thread ${id}`)
      if (filename === ":memory:") yield* note("no --db, so the thread lives in memory and ends with this chat")
      return { id, cursor: 0 }
    }
    const id = requested.value
    const opened = yield* threadStore.transaction(
      Effect.gen(function* () {
        const thread = yield* threadStore
          .getThread(id)
          .pipe(Effect.catchTag("ThreadNotFound", () => fail(`no thread ${id} in ${filename}`)))
        if (thread.agentId !== agent)
          return yield* Effect.andThen(
            identify(`thread ${id} belongs to agent ${clean(thread.agentId)}, not ${clean(agent)}`),
            Effect.fail(new CommandFailed()),
          )
        yield* requireOpen(thread)
        const run = thread.status.state === "running" ? yield* runStore.recoverThread(id, false) : undefined
        return {
          status: run?.thread.status ?? thread.status,
          pid: run?.kind === "alive" ? run.pid : null,
          cursor: yield* messageStore.latestMessageSeq(id),
        }
      }),
    )
    yield* identify(`thread ${id}`)
    yield* note(
      opened.pid !== null
        ? `running in process ${opened.pid}, so a line you type waits in its queue`
        : `${opened.status.state} (${opened.status.reason ?? "none"})`,
    )
    return { id, cursor: opened.cursor }
  })

type Ending = "input" | "closed"
type Turn = Fiber.Fiber<Delivery, unknown>

interface Conversation {
  readonly id: string
  readonly cursor: number
  readonly role: Message["role"]
  readonly onAdmitted: (seq: number) => void
  readonly identify: typeof note
  readonly clean: (text: string) => string
  readonly fullResults: boolean
  readonly trace: boolean
  readonly dumpRequests: boolean
}

const converse = (chat: Conversation) =>
  Effect.gen(function* () {
    const terminal = yield* openChatTerminal
    const messageStore = yield* MessageStore
    const threadStore = yield* ThreadStore
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
        for (const row of yield* messageStore.messagesAfter(chat.id, cursor)) {
          const sent = row.admission !== null && own.delete(row.admission)
          for (const line of messageLines(row.message, chat, sent)) yield* terminal.write(`${line}\n`)
          cursor = row.seq
        }
      }),
    )
    yield* flush
    let previous: Execution["settlement"] | undefined
    let waiting = false
    let atPrompt = true
    const finishPrevious = Effect.gen(function* () {
      if (!previous) return
      const turn = previous
      previous = undefined
      const outcome = yield* turn.await
      yield* flush
      yield* report(outcome)
    })
    const observe = (event: ExecutionEvent) =>
      Effect.gen(function* () {
        if (atPrompt || event.type === "queued") return
        waiting = false
        yield* finishPrevious
        if (event.type === "message") yield* flush
        if (event.type === "trace" && chat.trace) yield* write(`${formatTraceEntry(event.entry)}\n`)
        if (event.type === "request" && chat.dumpRequests) {
          yield* write(`${requestText(event.request)}\n`)
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
              holder.abortedOperation
                ? `${chat.clean(holder.abortedOperation)} has not returned since the abort, so the line waits in the queue until it does`
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
              yield* requireOpen(yield* threadStore.getThread(chat.id))
              yield* report(event.exit.value.outcome ?? event.exit.value.status)
              return "continue" as const
            }
            const error = Cause.squash(event.exit.cause)
            if (error instanceof ThreadTerminated) return yield* error
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
            previous = yield* supervisor.abort(chat.id)
            yield* Fiber.interrupt(turn)
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
      if (read.line.trim() === "") {
        yield* requireOpen(yield* threadStore.getThread(chat.id))
        continue
      }
      atPrompt = false
      if (previous?.isDone()) yield* finishPrevious
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
    fullResults: Flag.Boolean("full-results").pipe(
      Flag.withDescription("Show successful tool results beyond 200 characters"),
      Flag.withDefault(false),
    ),
    trace: deliveryFlags.trace,
    dumpRequests: deliveryFlags.dumpRequests,
  },
  (args) =>
    withOutput(({ secrets, identify, clean }) => {
      const db = Option.getOrElse(args.db, () => ":memory:")
      return withProject(
        Option.getOrElse(args.dir, () => "."),
        db,
        { agent: args.agent, resume: Option.isSome(args.thread) },
        args.script,
        secrets,
        (role, filename) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const thread = yield* openThread(args.agent, filename, args.thread, secrets, identify, clean)
            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                let lastAdmission: number | undefined
                const conversation = yield* Effect.exit(
                  restore(
                    converse({
                      ...thread,
                      role,
                      identify,
                      onAdmitted: (seq) => {
                        lastAdmission = seq
                      },
                      clean,
                      fullResults: args.fullResults,
                      trace: args.trace,
                      dumpRequests: args.dumpRequests,
                    }).pipe(Effect.scoped),
                  ),
                )
                // A conversation that a signal or an error ended still says how to resume the thread.
                const ending = Exit.isSuccess(conversation) ? conversation.value : "input"
                if (filename !== ":memory:" && !(yield* fs.exists(filename)))
                  return yield* fail(`the database ${db} is gone`)
                const threadStore = yield* ThreadStore
                const runStore = yield* RunStore
                yield* requireOpen(yield* threadStore.getThread(thread.id))
                if (lastAdmission !== undefined && (yield* runStore.isQueued(thread.id, lastAdmission)))
                  yield* note("your last line is still queued, and the next run of the thread delivers it")
                if (filename !== ":memory:") {
                  const dir = Option.isSome(args.dir) ? ` --dir ${shellWord(clean(args.dir.value))}` : ""
                  yield* identify(
                    `resume with spindle chat ${shellWord(clean(args.agent))} --thread ${shellWord(thread.id)} --db ${shellWord(clean(db))}${dir}`,
                  )
                }
                if (Exit.isFailure(conversation)) return yield* Effect.failCause(conversation.cause)
                if (ending === "closed") return yield* new CommandFailed()
              }),
            )
          }),
      )
    }, escapeControls),
).pipe(Command.withDescription("Chat with an agent on one thread until end of input or Ctrl-C"))
