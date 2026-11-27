import type { Message, ThreadStatus } from "@standardagents/spec"
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Option, Queue, Scheduler } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { Interrupts, openChatTerminal } from "#platform"
import { toolCallsOf } from "../execution/assemble.ts"
import type { Execution } from "../execution/Execution.ts"
import type { ExecutionEvent, RunOutcome } from "../execution/step.ts"
import { type Delivery, ThreadSupervisor, type WaitingHolder } from "../execution/ThreadSupervisor.ts"
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
  holdNote,
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
  reportId: (id: string) => Effect.Effect<void>,
  secrets: Set<string>,
  identify: typeof note,
  clean: (text: string) => string,
) =>
  Effect.gen(function* () {
    const threadStore = yield* ThreadStore
    const runStore = yield* RunStore
    const messageStore = yield* MessageStore
    if (Option.isNone(requested)) {
      const { id } = yield* createThread(agent, secrets, (id) =>
        filename === ":memory:"
          ? Effect.andThen(reportId(id), note("no --db, so the thread lives in memory and ends with this chat"))
          : reportId(id),
      )
      return { id, cursor: 0 }
    }
    const id = requested.value
    const opened = yield* threadStore.transaction(
      Effect.gen(function* () {
        const thread = yield* threadStore
          .getThread(id)
          .pipe(Effect.catchTag("ThreadNotFound", () => fail(`no thread ${id} in ${filename}`)))
        if (thread.agentId !== agent)
          return yield* fail(`thread ${id} belongs to agent ${clean(thread.agentId)}, not ${clean(agent)}`, identify)
        yield* requireOpen(thread)
        const run = thread.status.state === "running" ? yield* runStore.recoverThread(id, false) : undefined
        return {
          status: run?.thread.status ?? thread.status,
          pid: run?.kind === "alive" ? run.pid : null,
          cursor: yield* messageStore.latestMessageSeq(id),
        }
      }),
    )
    yield* reportId(id)
    yield* note(
      opened.pid !== null
        ? `running in process ${opened.pid}, so a line you type waits in its queue`
        : `${opened.status.state} (${opened.status.reason ?? "none"})`,
    )
    return { id, cursor: opened.cursor }
  })

type SendError = Effect.Error<ReturnType<ThreadSupervisor["Service"]["send"]>>
type Turn = Fiber.Fiber<Delivery, SendError>
type Event =
  | { kind: "interrupt" | "closed" }
  | { kind: "poll"; ack: Deferred.Deferred<void> }
  | { kind: "line"; line: string | null }
  | { kind: "admitted"; seq: number }
  | { kind: "waiting"; holder: WaitingHolder }
  | { kind: "record"; event: ExecutionEvent; ack: Deferred.Deferred<void> }
  | { kind: "settled"; settlement: Execution["settlement"] }
  | { kind: "done"; turn: Turn; exit: Exit.Exit<Delivery, SendError> }

type Phase =
  | { kind: "prompt" }
  | { kind: "running" | "waiting" | "stopping" | "closing"; turn: Turn; admitted: boolean }

interface Conversation {
  readonly id: string
  readonly cursor: number
  readonly role: Message["role"]
  readonly identify: typeof note
  readonly clean: (text: string) => string
  readonly fullResults: boolean
  readonly trace: boolean
  readonly dumpRequests: boolean
}

const converse = (chat: Conversation, events: Queue.Queue<Event>, own: Set<number>) =>
  Effect.gen(function* () {
    const terminal = yield* openChatTerminal
    const messageStore = yield* MessageStore
    const threadStore = yield* ThreadStore
    const supervisor = yield* ThreadSupervisor
    const interrupts = yield* (yield* Interrupts).listen
    const offer = (event: Event) => Queue.offer(events, event)
    yield* Effect.forkScoped(Effect.forever(Effect.andThen(Queue.take(interrupts), offer({ kind: "interrupt" }))))
    yield* Effect.forkScoped(Effect.andThen(terminal.outputClosed, offer({ kind: "closed" })))
    const write = (text: string) => terminal.write(chat.clean(text))
    let cursor = chat.cursor
    const flush = Effect.gen(function* () {
      for (const row of yield* messageStore.messagesAfter(chat.id, cursor)) {
        const sent = row.admission !== null && own.delete(row.admission)
        for (const line of messageLines(row.message, chat, sent)) yield* terminal.write(`${line}\n`)
        cursor = row.seq
      }
    })
    const open = Effect.flatMap(threadStore.getThread(chat.id), requireOpen)
    const prompt = Effect.gen(function* () {
      yield* write("> ")
      yield* Effect.forkScoped(Effect.flatMap(terminal.readLine, (line) => offer({ kind: "line", line })))
      return { kind: "prompt" } as const
    })
    const ended = yield* Deferred.make<void>()
    yield* Effect.addFinalizer(() => Deferred.succeed(ended, undefined))
    const observe = (event: ExecutionEvent) =>
      Effect.gen(function* () {
        const ack = yield* Deferred.make<void>()
        yield* offer({ kind: "record", event, ack })
        yield* Effect.raceFirst(Deferred.await(ack), Deferred.await(ended))
      })
    let previous: { settlement: Execution["settlement"]; ready: boolean } | undefined
    const finishPrevious = Effect.gen(function* () {
      if (!previous) return
      const outcome = yield* previous.settlement.await
      previous = undefined
      yield* flush
      yield* report(outcome)
    })
    yield* flush
    let phase: Phase = yield* prompt
    let poll: Fiber.Fiber<never> | undefined
    while (true) {
      const event = yield* Queue.take(events)
      switch (event.kind) {
        case "line": {
          if (event.line === null) return yield* finish("input")
          if (!terminal.isTerminal) yield* write(`${event.line}\n`)
          if (event.line.trim() === "") {
            yield* open
            phase = yield* prompt
            break
          }
          if (previous?.ready) yield* finishPrevious
          yield* flush
          const turn = yield* Effect.forkScoped(
            supervisor.send(chat.id, event.line, {
              observe,
              onHold: (operation) =>
                chat.identify(holdNote(chat.id, operation, chat.clean, "abort, then once at the prompt to exit")),
              onAdmitted: (seq) => {
                Queue.offerUnsafe(events, { kind: "admitted", seq })
              },
              onWaiting: (holder) => Effect.asVoid(offer({ kind: "waiting", holder })),
            }),
          )
          turn.addObserver((exit) => Queue.offerUnsafe(events, { kind: "done", turn, exit }))
          phase = { kind: "running", turn, admitted: false }
          break
        }
        case "admitted":
          own.add(event.seq)
          if (phase.kind !== "prompt") phase.admitted = true
          break
        case "waiting": {
          if (phase.kind !== "running" && phase.kind !== "waiting") break
          phase.kind = "waiting"
          const { holder } = event
          yield* chat.identify(
            holder.kind === "local" && holder.operation
              ? `${chat.clean(holder.operation)} has not returned, so the line waits in the queue until it does`
              : `thread ${chat.id} is running in process ${holder.pid}, so the line waits in its queue`,
          )
          if (holder.kind === "remote" && !poll)
            poll = yield* Effect.forkScoped(
              Effect.forever(
                Effect.gen(function* () {
                  yield* Effect.sleep("50 millis")
                  const ack = yield* Deferred.make<void>()
                  yield* offer({ kind: "poll", ack })
                  yield* Deferred.await(ack)
                }),
              ),
            )
          break
        }
        case "poll":
          if (phase.kind === "waiting") yield* flush
          yield* Deferred.succeed(event.ack, undefined)
          break
        case "settled":
          if (previous?.settlement === event.settlement) {
            previous.ready = true
            if (phase.kind !== "prompt") yield* finishPrevious
          }
          break
        case "record": {
          if (phase.kind !== "prompt" && phase.kind !== "closing") {
            if (phase.kind === "waiting") phase.kind = "running"
            yield* finishPrevious
            const record = event.event
            if (record.type === "message") yield* flush
            if (record.type === "trace" && chat.trace) yield* write(`${formatTraceEntry(record.entry)}\n`)
            if (record.type === "request" && chat.dumpRequests) yield* write(`${requestText(record.request)}\n`)
            if ((yield* terminal.isOutputClosed) && (yield* supervisor.stop(chat.id))) phase.kind = "closing"
          }
          yield* Deferred.succeed(event.ack, undefined)
          break
        }
        case "done":
          if (phase.kind === "prompt" || phase.turn !== event.turn) break
          if (phase.kind === "closing") return yield* finish("closed")
          if (Exit.isSuccess(event.exit)) {
            yield* finishPrevious
            yield* flush
            yield* open
            yield* report(event.exit.value.outcome ?? event.exit.value.status)
          } else {
            const error = Cause.squash(event.exit.cause)
            if (error instanceof ThreadTerminated) return yield* error
            const problem = phase.admitted ? "the line was sent, but the run could not finish" : "the line was not sent"
            yield* note(`${problem}: ${describe(error)}`)
          }
          phase = yield* prompt
          break
        case "closed":
        case "interrupt": {
          if (phase.kind === "closing") break
          const ending = event.kind === "closed" ? "closed" : "input"
          if (phase.kind === "prompt" || phase.kind === "waiting" || !(yield* supervisor.stop(chat.id)))
            return yield* finish(ending)
          if (event.kind === "closed") phase.kind = "closing"
          else if (phase.kind === "stopping") {
            yield* note("aborting the run")
            const settlement = yield* supervisor.abort(chat.id)
            if (settlement) {
              previous = { settlement, ready: false }
              yield* Effect.forkScoped(
                Effect.andThen(Effect.exit(settlement.await), offer({ kind: "settled", settlement })),
              )
            }
            yield* Fiber.interrupt(phase.turn)
            phase = yield* prompt
          } else {
            phase.kind = "stopping"
            yield* note("stopping after the current operation. Press Ctrl-C again to abort.")
          }
          break
        }
      }
      if (poll && phase.kind !== "waiting") {
        yield* Fiber.interrupt(poll)
        poll = undefined
      }
    }
    function finish(reason: "input" | "closed") {
      return Effect.gen(function* () {
        if (reason === "input") yield* write("\n")
        if (yield* terminal.isOutputClosed) reason = "closed"
        if (reason === "closed") yield* note("standard output is closed")
        return reason
      })
    }
  })

export const chatCommand = Command.make(
  "chat",
  {
    agent: Argument.String("agent"),
    dir: Flag.String("dir").pipe(Flag.optional),
    db: Flag.String("db").pipe(Flag.optional),
    thread: Flag.String("thread").pipe(Flag.optional),
    script: deliveryFlags.script,
    toolTimeout: deliveryFlags.toolTimeout,
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
        args.toolTimeout,
        secrets,
        (role, filename) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            let openedId: string | undefined
            const reportId = (id: string) => {
              openedId = id
              return identify(`thread ${id}`)
            }
            const open = openThread(args.agent, filename, args.thread, reportId, secrets, identify, clean)
            return yield* Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                // A transcript acknowledgement must not give pending OS signals an extra event-loop turn.
                const events = yield* Queue.make<Event>().pipe(
                  Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync")),
                )
                const own = new Set<number>()
                const conversation = yield* Effect.exit(
                  restore(
                    Effect.flatMap(open, (thread) =>
                      converse({ ...args, ...thread, role, identify, clean }, events, own).pipe(Effect.scoped),
                    ),
                  ),
                )
                if (openedId !== undefined) {
                  // The scope joins admission even if a signal arrived during its transaction.
                  for (const event of yield* Queue.clear(events)) if (event.kind === "admitted") own.add(event.seq)
                  const lastAdmission = [...own].at(-1)
                  if (filename !== ":memory:" && !(yield* fs.exists(filename)))
                    return yield* fail(`the database ${db} is gone`)
                  const threadStore = yield* ThreadStore
                  const runStore = yield* RunStore
                  yield* requireOpen(yield* threadStore.getThread(openedId))
                  if (lastAdmission !== undefined && (yield* runStore.isQueued(openedId, lastAdmission)))
                    yield* note("your last line is still queued, and the next run of the thread delivers it")
                  if (filename !== ":memory:") {
                    const dir = Option.isSome(args.dir) ? ` --dir ${shellWord(clean(args.dir.value))}` : ""
                    yield* identify(
                      `resume with spindle chat ${shellWord(clean(args.agent))} --thread ${shellWord(openedId)} --db ${shellWord(clean(db))}${dir}`,
                    )
                  }
                }
                if (Exit.isFailure(conversation)) return yield* Effect.failCause(conversation.cause)
                if (conversation.value === "closed") return yield* new CommandFailed()
              }),
            )
          }),
      )
    }, escapeControls),
).pipe(
  Command.withDescription(
    "Chat with an agent on one thread until end of input or Ctrl-C. The terminal limits typed or pasted lines (1,024 bytes or more never arrive on macOS), so pipe longer input into chat or use spindle send.",
  ),
)
