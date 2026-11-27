import { type Cause, Effect, FileSystem, Path, Queue, Stream } from "effect"
import { platformName } from "#platform"
import { type Child, main, query, startCommand, until } from "./processes.ts"

// The chat tests run the real command in a child process, type into its standard input, and read what it prints.
// A test orders events with the gate files of the queue fixture and with the lines the command has printed so far.
// docs/plans/briefs/m1-7.md holds the output contract that the lines below repeat.
const source = (relative: string) => new URL(relative, import.meta.url).pathname
const terminal = source("./terminal.py")
const fixtures = source("../../../conformance/fixtures")

export const fixture = (name: string) => `${fixtures}/${name}`

// The packages that a fixture's definitions import. A test that copies a fixture links them beside the copy.
export const conformanceModules = source("../../../conformance/node_modules")

export interface Session extends Pick<Child, "pid" | "exit" | "signal"> {
  // Everything printed so far, as text. A prompt has no newline, so a test reads the text and not a list of lines.
  readonly out: () => string
  readonly err: () => string
  readonly type: (text: string) => Effect.Effect<void>
  // Closes standard input, which is the end of input for a command that reads a pipe.
  readonly end: Effect.Effect<void>
}

const launch = (gate: string, words: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const keys = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    const output = { out: "", err: "" }
    const child = yield* startCommand(
      gate,
      words,
      (channel, text) =>
        Stream.runForEach(text, (chunk) =>
          Effect.sync(() => {
            output[channel] += chunk
          }),
        ),
      {
        env,
        stdin: { stream: Stream.fromQueue(keys), endOnDone: true },
      },
    )
    return {
      ...child,
      out: () => output.out,
      err: () => output.err,
      type: (text) => Effect.asVoid(Queue.offer(keys, new TextEncoder().encode(text))),
      end: Effect.asVoid(Queue.end(keys)),
    } satisfies Session
  })

const command = [platformName, "--conditions=spindle-source", main]

export interface ChatOptions {
  readonly env?: Record<string, string>
  // streams keeps standard output and standard error apart. merged joins them in the order the command wrote them,
  // which is what a person sees. terminal runs the command on a pseudo-terminal, so its input is a terminal too.
  readonly view?: "streams" | "merged" | "terminal"
}

export const chat = (gate: string, args: ReadonlyArray<string>, options: ChatOptions = {}) => {
  const words = [...command, "chat", ...args]
  const view = options.view ?? "streams"
  if (view === "merged") return launch(gate, ["sh", "-c", 'exec "$@" 2>&1', "sh", ...words], options.env)
  if (view === "terminal") return launch(gate, ["python3", terminal, ...words], options.env)
  return launch(gate, words, options.env)
}

// Runs any other spindle command to its end, with the environment a chat gets.
export const spindleWith = (gate: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  launch(gate, [...command, ...args], env)

// Runs a line of shell that names the command as "$@", for the cases a plain child process cannot make.
export const shell = (gate: string, script: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  launch(gate, ["sh", "-c", script, "sh", ...command, ...args], env)

const segments = (text: string) => text.split("\n")

export { linesOf, printed } from "./processes.ts"

const promptsIn = (text: string) => segments(text).filter((line) => line.startsWith("> ")).length

// Waits until the command shows its nth prompt and is reading. The deadline only bounds a failure.
export const prompt = (session: Session, n: number) =>
  until(
    `prompt ${n}`,
    Effect.sync(() => promptsIn(session.out()) === n && segments(session.out()).at(-1) === "> "),
  )

const THREAD = /^spindle: thread ([0-9a-f-]{36})$/m

export const threadOf = (session: Session) =>
  Effect.gen(function* () {
    // A terminal can wrap the line in color codes, so the id is read from what the screen showed.
    const text = () => screen(`${session.err()}\n${session.out()}`)
    yield* until(
      "the thread line",
      Effect.sync(() => THREAD.test(text())),
    )
    return text().match(THREAD)?.[1] ?? ""
  })

// What a terminal showed, without the bytes that only move the cursor or echo a control key.
export const screen = (text: string) =>
  text
    .replaceAll("\r", "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences of a terminal start with this byte
    .replaceAll(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replaceAll("^C", "")
    .replaceAll("^D", "")
    .replaceAll("\b", "")

// A word of the resume line, quoted for the shell when it holds a character the shell reads.
const word = (text: string) => (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`)

// The notes of the output contract, part 2 of the brief. Each is one line on standard error.
export const note = {
  thread: (id: string) => `spindle: thread ${id}`,
  memory: "spindle: no --db, so the thread lives in memory and ends with this chat",
  status: (state: "idle" | "failed", reason: string) => `spindle: ${state} (${reason})`,
  heldAtStart: (pid: number) => `spindle: running in process ${pid}, so a line you type waits in its queue`,
  stopping: "spindle: stopping after the current operation. Press Ctrl-C again to abort.",
  aborting: "spindle: aborting the run",
  providerError: (message: string) => `spindle: provider error: ${message}`,
  behindProcess: (id: string, pid: number) =>
    `spindle: thread ${id} is running in process ${pid}, so the line waits in its queue`,
  behindTool: (name: string) =>
    `spindle: tool ${name} has not returned since the abort, so the line waits in the queue until it does`,
  notSent: "spindle: the line was not sent: ",
  stillQueued: "spindle: your last line is still queued, and the next run of the thread delivers it",
  resume: (agent: string, id: string, db: string, dir?: string) =>
    `spindle: resume with spindle chat ${agent} --thread ${id} --db ${word(db)}${dir === undefined ? "" : ` --dir ${word(dir)}`}`,
  outputClosed: "spindle: standard output is closed",
  noThread: (id: string, db: string) => `spindle: no thread ${id} in ${db}`,
  terminated: (id: string) =>
    `spindle: thread ${id} is terminated, so it takes no new message, queued work, or execution`,
  otherAgent: (id: string, owner: string, asked: string) =>
    `spindle: thread ${id} belongs to agent ${owner}, not ${asked}`,
  threadNeedsDb: "spindle: --thread needs --db",
} as const

// A message of the human side asks the gated model of the queue fixture for these tool calls.
export const call = (name: string, args: Record<string, unknown>) =>
  `call:${JSON.stringify([{ name, arguments: args }])}`

export const callLine = (name: string, args: Record<string, unknown>) => `[tool call] ${name} ${JSON.stringify(args)}`

// The rows a thread stores, in order, as [role, content or tool status].
export const messagesOf = (db: string, thread: string) =>
  Effect.map(
    query(db, "SELECT role, content, tool_status, name FROM messages WHERE thread_id = ? ORDER BY seq", [thread]),
    (rows) => rows.map((row) => [row.role, row.role === "tool" ? row.tool_status : row.content]),
  )

export const statusOf = (db: string, thread: string) =>
  Effect.map(query(db, "SELECT run_state, run_reason FROM threads WHERE id = ?", [thread]), ([row]) => [
    row?.run_state,
    row?.run_reason ?? null,
  ])

export const queuedIn = (db: string, thread: string) =>
  Effect.map(query(db, "SELECT payload FROM queue WHERE thread_id = ? ORDER BY seq", [thread]), (rows) =>
    rows.map((row) => String(row.payload)),
  )

// The provider requests that the gated model recorded, as the process ids that made them.
export const requesters = (gate: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return (yield* fs.readDirectory(gate))
      .filter((name) => name.startsWith("request-"))
      .map((name) => Number(name.split("-")[1]))
  })

export const requestOf = (gate: string, pid: number, n: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const text = yield* fs.readFileString(path.join(gate, `request-${pid}-${n}.json`))
    return JSON.parse(text) as { messages: Array<{ role: string; content: unknown }> }
  })
