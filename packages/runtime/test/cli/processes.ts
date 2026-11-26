import { Effect, Fiber, FileSystem, Layer, Path, type Scope, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { SqlClient } from "effect/sql/SqlClient"
import { platformName, SqliteLive } from "#platform"

// The tests that use this module run the real command in separate processes on one database file. The gated model
// and the tools of the queue fixture wait for files that a test creates, so every ordering is one the test made.
const source = (relative: string) => new URL(relative, import.meta.url).pathname
export const main = source("../../src/cli/main.ts")
export const probe = source("../../scripts/queue-probe.ts")
export const fixture = source("../../../conformance/fixtures/queue")
const shiftClock = source("../../../conformance/fixtures/queue/shift-clock.mjs")

export const project = ["--dir", fixture]

export interface Child {
  readonly pid: number
  readonly out: Array<string>
  readonly err: Array<string>
  readonly exit: Effect.Effect<number, unknown>
  // Sends the signal and returns. A process that a signal killed has no exit code, so exit reads -1 for it.
  readonly signal: (signal: "SIGKILL" | "SIGINT") => Effect.Effect<void, never, Scope.Scope>
}

export interface SpawnOptions {
  // Moves the wall clock of the process by this many milliseconds.
  readonly clockShiftMs?: number
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>, into: Array<string>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => Effect.sync(() => into.push(line))),
  )

export const spawn = (gate: string, script: string, args: ReadonlyArray<string>, options: SpawnOptions = {}) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const shifted = options.clockShiftMs !== undefined
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        platformName,
        [...(shifted ? ["--import", shiftClock] : []), "--conditions=spindle-source", script, ...args],
        {
          env: {
            SPINDLE_GATE_DIR: gate,
            NODE_NO_WARNINGS: "1",
            ...(shifted ? { SPINDLE_CLOCK_SHIFT_MS: String(options.clockShiftMs) } : {}),
          },
          extendEnv: true,
        },
      ),
    )
    const out: Array<string> = []
    const err: Array<string> = []
    const reading = yield* Effect.forkScoped(
      Effect.all([collect(handle.stdout, out), collect(handle.stderr, err)], { concurrency: 2 }),
    )
    return {
      pid: Number(handle.pid),
      out,
      err,
      exit: handle.exitCode.pipe(
        Effect.map(Number),
        Effect.orElseSucceed(() => -1),
        Effect.tap(() => Fiber.join(reading)),
      ),
      // kill waits until the process exits, so it runs on its own fiber.
      signal: (signal) => Effect.asVoid(Effect.forkScoped(Effect.ignore(handle.kill({ killSignal: signal })))),
    } satisfies Child
  })

export const spindle = (gate: string, args: ReadonlyArray<string>, options?: SpawnOptions) =>
  spawn(gate, main, args, options)

// Runs a system command to its end and returns what it printed.
const command = (name: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(name, [...args]))
    const out: Array<string> = []
    yield* collect(handle.stdout, out)
    yield* Effect.ignore(handle.exitCode)
    return out
  }).pipe(Effect.scoped)

// Waits for a condition that the processes make true. The deadline only bounds a failure.
export const until = <E, R>(what: string, check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 1500; tries++) {
      if (yield* check) return
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`))
  })

const processState = (pid: number) =>
  Effect.map(command("ps", ["-o", "stat=", "-p", String(pid)]), (lines) => lines.join("").trim())

// Stops the process as a debugger or a suspended machine does. It stays alive and runs nothing until resume.
export const freeze = (child: Child) =>
  Effect.andThen(
    command("kill", ["-STOP", String(child.pid)]),
    until(
      `process ${child.pid} to stop`,
      Effect.map(processState(child.pid), (state) => state.startsWith("T")),
    ),
  )

export const resume = (child: Child) => Effect.asVoid(command("kill", ["-CONT", String(child.pid)]))

const fileSystem = Effect.gen(function* () {
  return yield* FileSystem.FileSystem
})

export const exists = (file: string) => Effect.flatMap(fileSystem, (fs) => fs.exists(file))

export const touch = (file: string) => Effect.flatMap(fileSystem, (fs) => fs.writeFileString(file, ""))

export const entries = (dir: string) => Effect.flatMap(fileSystem, (fs) => fs.readDirectory(dir))

export const lines = (file: string) =>
  Effect.flatMap(fileSystem, (fs) =>
    Effect.map(fs.readFileString(file), (text) => text.split("\n").filter((line) => line !== "")),
  )

export const threadIn = (child: Child) =>
  Effect.gen(function* () {
    yield* until(
      "the thread id",
      Effect.sync(() => child.err.some((line) => line.startsWith("spindle: thread "))),
    )
    return child.err.find((line) => line.startsWith("spindle: thread "))?.slice("spindle: thread ".length) ?? ""
  })

export const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const gate = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-ownership-" })
  return { gate, db: path.join(gate, "spindle.db"), at: (name: string) => path.join(gate, name) }
})

export type Row = Record<string, unknown>

// One statement on a connection of the test's own, which no command uses.
export const query = (db: string, statement: string, parameters: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return yield* sql.unsafe<Row>(statement, parameters)
  }).pipe(Effect.provide(Layer.fresh(SqliteLive({ filename: db }))))

// What the thread stores, row by row, for a comparison before and after a process that must change nothing.
export const stored = (db: string, thread: string) =>
  Effect.gen(function* () {
    const [row] = yield* query(db, "SELECT * FROM threads WHERE id = ?", [thread])
    const messages = yield* query(db, "SELECT * FROM messages WHERE thread_id = ? ORDER BY seq", [thread])
    const queue = yield* query(db, "SELECT * FROM queue WHERE thread_id = ? ORDER BY seq", [thread])
    const values = yield* query(db, "SELECT * FROM kv WHERE thread_id = ? ORDER BY key", [thread])
    return {
      status: [row?.run_state, row?.run_reason ?? null],
      terminated: row?.terminated_at ?? null,
      flow: row?.flow_id ?? null,
      revision: row?.revision,
      messages: messages.map((message) => [message.role, message.tool_status ?? message.content]),
      queue: queue.map((entry) => [entry.kind, entry.payload]),
      values: values.map((value) => [value.key, value.value]),
    }
  })
