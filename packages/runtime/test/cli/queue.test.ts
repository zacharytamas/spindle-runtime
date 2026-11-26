import { describe, expect, it } from "@effect/vitest"
import type { Message } from "@standardagents/spec"
import { Effect, Fiber, FileSystem, Layer, Path, type Scope, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { PlatformLive, platformName, SqliteLive } from "#platform"
import { CLOSING } from "../../src/execution/run-status.ts"
import { layer as storeLayer } from "../../src/store/sqlite.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"

// Each test runs the real command in separate processes on one database file. The gated model and the hold tool of the
// queue fixture wait for files that the test creates, so every ordering below is one the test made, not a timing.
const source = (relative: string) => new URL(relative, import.meta.url).pathname
const main = source("../../src/cli/main.ts")
const probe = source("../../scripts/queue-probe.ts")
const fixture = source("../../../conformance/fixtures/queue")

interface Child {
  readonly pid: number
  readonly out: Array<string>
  readonly err: Array<string>
  readonly exit: Effect.Effect<number, unknown>
  // Sends the signal and returns. A process that a signal killed has no exit code, so exit reads -1 for it.
  readonly signal: (signal: "SIGKILL" | "SIGINT") => Effect.Effect<void, never, Scope.Scope>
}

const spawn = (gate: string, script: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(platformName, ["--conditions=spindle-source", script, ...args], {
        env: { SPINDLE_GATE_DIR: gate, NODE_NO_WARNINGS: "1" },
        extendEnv: true,
      }),
    )
    const out: Array<string> = []
    const err: Array<string> = []
    const collect = (stream: Stream.Stream<Uint8Array, unknown>, into: Array<string>) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => Effect.sync(() => into.push(line))),
      )
    const reading = yield* Effect.forkScoped(
      Effect.all([collect(handle.stdout, out), collect(handle.stderr, err)], { concurrency: 2 }),
    )
    return {
      pid: Number(handle.pid),
      out,
      err,
      exit: handle.exitCode.pipe(
        Effect.map(Number),
        Effect.catch(() => Effect.succeed(-1)),
        Effect.flatMap((code) => Effect.as(Fiber.join(reading), code)),
      ),
      // kill waits until the process exits, so it runs on its own fiber.
      signal: (signal) => Effect.asVoid(Effect.forkScoped(Effect.ignore(handle.kill({ killSignal: signal })))),
    } satisfies Child
  })

const spindle = (gate: string, args: ReadonlyArray<string>) => spawn(gate, main, args)

// Waits for a condition that the processes make true. The deadline only bounds a failure.
const until = <E, R>(what: string, check: Effect.Effect<boolean, E, R>) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 1500; tries++) {
      if (yield* check) return
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.die(new Error(`timed out waiting for ${what}`))
  })

const fileSystem = Effect.gen(function* () {
  return yield* FileSystem.FileSystem
})

const threadStore = Effect.gen(function* () {
  return yield* ThreadStore
})

const exists = (file: string) => Effect.flatMap(fileSystem, (fs) => fs.exists(file))

const touch = (file: string) => Effect.flatMap(fileSystem, (fs) => fs.writeFileString(file, ""))

const entries = (dir: string) => Effect.flatMap(fileSystem, (fs) => fs.readDirectory(dir))

const lines = (file: string) =>
  Effect.flatMap(fileSystem, (fs) =>
    Effect.map(fs.readFileString(file), (text) => text.split("\n").filter((line) => line !== "")),
  )

const threadIn = (child: Child) =>
  Effect.gen(function* () {
    yield* until(
      "the thread id",
      Effect.sync(() => child.err.some((line) => line.startsWith("spindle: thread "))),
    )
    return child.err.find((line) => line.startsWith("spindle: thread "))?.slice("spindle: thread ".length) ?? ""
  })

const storeAt = (filename: string) => Layer.fresh(storeLayer.pipe(Layer.provide(SqliteLive({ filename }))))

const shape = (messages: ReadonlyArray<Message>) =>
  messages.map((message) => [message.role, message.role === "tool" ? message.tool_status : message.content])

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const gate = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-queue-" })
  return { gate, db: path.join(gate, "spindle.db"), at: (name: string) => path.join(gate, name) }
})

const project = ["--dir", fixture]

describe("spindle across processes", () => {
  it.live(
    "two processes that send to one thread at once run one execution and store each message once",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const first = yield* spindle(gate, ["run", "assistant", "-m", "setup", ...project, "--db", db])
        expect(yield* first.exit).toBe(0)
        const thread = yield* threadIn(first)
        yield* touch(at("hold-model"))
        const a = yield* spindle(gate, ["send", thread, "-m", "alpha", ...project, "--db", db])
        const b = yield* spindle(gate, ["send", thread, "-m", "beta", ...project, "--db", db])
        const queued = (child: Child) => child.err.some((line) => line.endsWith("so the message waits in its queue"))
        yield* until(
          "one process to queue behind the other",
          Effect.sync(() => queued(a) || queued(b)),
        )
        yield* until(
          "the other process to enter the model",
          Effect.map(entries(gate), (names) => names.some((name) => name.startsWith("model-entered-"))),
        )
        const [owner, waiter] = queued(a) ? [b, a] : [a, b]
        const status = yield* spindle(gate, ["status", thread, "--db", db])
        expect(yield* status.exit).toBe(0)
        expect(status.out[0]).toMatch(/^running none since /)
        expect(status.out[1]).toBe(`held by process ${owner.pid}`)
        yield* touch(at("release-model"))
        expect([yield* owner.exit, yield* waiter.exit]).toEqual([0, 0])
        const requests = (yield* entries(gate)).filter((name) => name.startsWith("request-"))
        expect(
          requests.every(
            (name) => name.startsWith(`request-${owner.pid}-`) || name.startsWith(`request-${first.pid}-`),
          ),
        ).toBe(true)
        const messages = yield* Effect.flatMap(threadStore, (store) =>
          Effect.map(store.getMessages(thread, { order: "asc", includeSilent: true }), (result) => result.messages),
        ).pipe(Effect.provide(storeAt(db)))
        const human = messages.filter((message) => message.role === "user").map((message) => message.content)
        expect(human.slice(0, 1)).toEqual(["setup"])
        expect([...human.slice(1)].sort()).toEqual(["alpha", "beta"])
        expect(waiter.err.at(-1)).toBe(`spindle: idle (stop_on_response), thread ${thread}`)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a process killed in a model call leaves a thread that live observers settle as lost while another thread runs on",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-model"))
        const lost = yield* spindle(gate, ["run", "assistant", "-m", "first", ...project, "--db", db])
        const thread = yield* threadIn(lost)
        const other = yield* spindle(gate, ["run", "assistant", "-m", "elsewhere", ...project, "--db", db])
        const otherThread = yield* threadIn(other)
        yield* until(
          "both processes to enter the model",
          Effect.map(entries(gate), (names) => names.filter((name) => name.startsWith("model-entered-")).length === 2),
        )
        // An observer that opened the file before the crash, and two senders whose messages wait in the queue.
        const observer = yield* Layer.build(storeAt(db))
        const store = yield* Effect.provide(threadStore, observer)
        const x = yield* spindle(gate, ["send", thread, "-m", "x", ...project, "--db", db])
        yield* until(
          "x to queue",
          Effect.sync(() => x.err.some((line) => line.includes("waits in its queue"))),
        )
        const y = yield* spindle(gate, ["send", thread, "-m", "y", ...project, "--db", db])
        yield* until(
          "y to queue",
          Effect.sync(() => y.err.some((line) => line.includes("waits in its queue"))),
        )
        yield* lost.signal("SIGKILL")
        yield* lost.exit
        yield* until(
          "the observer to see the run lost",
          Effect.map(
            Effect.andThen(store.recover(thread), store.getThread(thread)),
            (found) => found.status.state === "failed",
          ),
        )
        expect((yield* store.getThread(thread)).status).toMatchObject({ state: "failed", reason: "execution_lost" })
        expect((yield* store.getThread(otherThread)).status).toMatchObject({ state: "running", reason: null })
        const status = yield* spindle(gate, ["status", thread, "--db", db])
        expect(yield* status.exit).toBe(0)
        expect(status.out).toEqual([expect.stringMatching(/^failed execution_lost since /), "queued 2"])
        expect([yield* x.exit, yield* y.exit]).toEqual([1, 1])
        expect(x.err.at(-1)).toBe(
          `spindle: the run of thread ${thread} ended execution_lost. Your message is still queued and the next run of this thread will deliver it.`,
        )
        yield* touch(at("release-model"))
        expect(yield* other.exit).toBe(0)
        const again = yield* spindle(gate, ["send", thread, "-m", "z", ...project, "--db", db])
        expect(yield* again.exit).toBe(0)
        expect(again.out).toEqual(["ack: first | x | y | z"])
        expect(shape((yield* store.getMessages(thread, { order: "asc", includeSilent: true })).messages)).toEqual([
          ["user", "first"],
          ["user", "x"],
          ["user", "y"],
          ["user", "z"],
          ["assistant", "ack: first | x | y | z"],
        ])
        expect((yield* store.getThread(thread)).status).toMatchObject({ state: "idle", reason: "stop_on_response" })
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a process killed in a tool leaves the response and the first result, an error result for the open call, and the queue",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const calls = JSON.stringify([
          { name: "echo", arguments: { text: "one" } },
          { name: "hold", arguments: { name: "b" } },
        ])
        const run = yield* spindle(gate, ["run", "assistant", "-m", `call:${calls}`, ...project, "--db", db])
        const thread = yield* threadIn(run)
        yield* until("the second tool to start", exists(at("tool-entered-b")))
        const token = yield* spindle(gate, ["send", thread, "-m", "token", ...project, "--db", db])
        yield* until(
          "the token to queue",
          Effect.sync(() => token.err.some((line) => line.includes("waits in its queue"))),
        )
        yield* run.signal("SIGKILL")
        yield* run.exit
        expect(yield* token.exit).toBe(1)
        const store = yield* Effect.provide(threadStore, yield* Layer.build(storeAt(db)))
        const stored = (yield* store.getMessages(thread, { order: "asc", includeSilent: true })).messages
        expect(shape(stored)).toEqual([
          ["user", `call:${calls}`],
          ["assistant", null],
          ["tool", "success"],
          ["tool", "error"],
        ])
        expect(stored[3]).toMatchObject({ name: "hold", content: CLOSING.lost, prompt: "assistant" })
        expect((yield* store.getThread(thread)).status).toMatchObject({ state: "failed", reason: "execution_lost" })
        expect(yield* store.queueLength(thread)).toBe(1)
        const after = yield* spindle(gate, ["send", thread, "-m", "after", ...project, "--db", db])
        expect(yield* after.exit).toBe(0)
        expect(after.out).toEqual(["ack: token | after"])
        expect(yield* lines(at("tool-log"))).toEqual(["echo one", "b"])
        expect(
          shape((yield* store.getMessages(thread, { order: "asc", includeSilent: true })).messages).slice(4),
        ).toEqual([
          ["user", "token"],
          ["user", "after"],
          ["assistant", "ack: token | after"],
        ])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a terminate from another process aborts the running tool, and every later admission fails",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const hold = JSON.stringify([{ name: "hold", arguments: { name: "t", watch: true } }])
        const run = yield* spindle(gate, ["run", "assistant", "-m", `call:${hold}`, ...project, "--db", db])
        const thread = yield* threadIn(run)
        yield* until("the tool to start", exists(at("tool-entered-t")))
        const queued = yield* spawn(gate, probe, [
          "queue-message",
          "--thread",
          thread,
          "--role",
          "user",
          "--content",
          "q",
          ...project,
          "--db",
          db,
        ])
        expect(yield* queued.exit).toBe(0)
        const terminate = yield* spawn(gate, probe, ["terminate", "--thread", thread, ...project, "--db", db])
        expect(yield* terminate.exit).toBe(0)
        expect(yield* run.exit).toBe(0)
        expect(run.err.at(-1)).toBe(`spindle: idle (aborted) after 1 step, thread ${thread}`)
        expect(yield* exists(at("tool-aborted-t"))).toBe(true)
        const status = yield* spindle(gate, ["status", thread, "--db", db])
        expect(yield* status.exit).toBe(0)
        expect(status.out).toEqual([
          expect.stringMatching(/^idle aborted since /),
          "queued 1",
          expect.stringMatching(/^terminated \d{4}-\d\d-\d\dT.*Z \(\d{16}\)$/),
        ])
        const refusal = `thread ${thread} is terminated, so it takes no new message, queued work, or execution`
        const send = yield* spindle(gate, ["send", thread, "-m", "late", ...project, "--db", db])
        expect(yield* send.exit).toBe(1)
        expect(send.err.at(-1)).toBe(`spindle: ${refusal}`)
        for (const args of [
          ["queue-message", "--role", "user", "--content", "late"],
          ["queue-tool", "--tool", "echo", "--args", '{"text":"late"}'],
        ]) {
          const refused = yield* spawn(gate, probe, [...args, "--thread", thread, ...project, "--db", db])
          expect(yield* refused.exit).toBe(1)
          expect(refused.out).toEqual([`refused ${refusal}`])
        }
        expect((yield* entries(gate)).filter((name) => name.startsWith("request-"))).toHaveLength(1)
        expect(yield* lines(at("tool-log"))).toEqual(["t"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "one Ctrl-C ends a waiting sender and leaves its message with the running process",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const hold = JSON.stringify([{ name: "hold", arguments: { name: "owner" } }])
        const owner = yield* spindle(gate, ["run", "assistant", "-m", `call:${hold}`, ...project, "--db", db])
        const thread = yield* threadIn(owner)
        yield* until("the owner to enter the tool", exists(at("tool-entered-owner")))
        const waiter = yield* spindle(gate, ["send", thread, "-m", "waiting", ...project, "--db", db])
        yield* until(
          "the sender to queue its message",
          Effect.sync(() => waiter.err.some((line) => line.includes("waits in its queue"))),
        )
        const store = yield* Effect.provide(threadStore, yield* Layer.build(storeAt(db)))
        const claim = yield* store.holderOf(thread)
        const entry = yield* store.nextQueued(thread)
        expect(claim?.pid).toBe(owner.pid)
        expect(entry).toMatchObject({ kind: "message", message: { content: "waiting" } })
        yield* waiter.signal("SIGINT")
        expect(yield* waiter.exit.pipe(Effect.timeout("5 seconds"))).toBe(130)
        expect(waiter.err.at(-1)).toBe(
          "spindle: Your message is still queued and the next run of this thread will deliver it.",
        )
        expect(yield* store.holderOf(thread)).toEqual(claim)
        expect(yield* store.nextQueued(thread)).toEqual(entry)
        yield* touch(at("release-owner"))
        expect(yield* owner.exit).toBe(0)
        expect(owner.out.at(-1)).toBe("ack: waiting")
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "the first Ctrl-C of spindle run lets the running tool finish and stops before the next step",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const hold = JSON.stringify([{ name: "hold", arguments: { name: "a" } }])
        const run = yield* spindle(gate, ["run", "assistant", "-m", `call:${hold}`, ...project, "--db", db])
        const thread = yield* threadIn(run)
        yield* until("the tool to start", exists(at("tool-entered-a")))
        yield* run.signal("SIGINT")
        yield* until(
          "the stop note",
          Effect.sync(() => run.err.some((line) => line.includes("Press Ctrl-C again"))),
        )
        yield* touch(at("release-a"))
        expect(yield* run.exit).toBe(0)
        expect(run.err.at(-1)).toBe(`spindle: idle (aborted_by_user) after 1 step, thread ${thread}`)
        expect(run.out).toEqual([
          `[tool call] hold {"name":"a"}`,
          "[tool result] hold success: released a, aborted false",
        ])
        expect((yield* entries(gate)).filter((name) => name.startsWith("request-"))).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "the second Ctrl-C of spindle run aborts a tool that ignores the signal and leaves the thread open",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const hold = JSON.stringify([{ name: "hold", arguments: { name: "b" } }])
        const run = yield* spindle(gate, ["run", "assistant", "-m", `call:${hold}`, ...project, "--db", db])
        const thread = yield* threadIn(run)
        yield* until("the tool to start", exists(at("tool-entered-b")))
        yield* run.signal("SIGINT")
        yield* until(
          "the stop note",
          Effect.sync(() => run.err.some((line) => line.includes("Press Ctrl-C again"))),
        )
        yield* run.signal("SIGINT")
        expect(yield* run.exit).toBe(0)
        expect(run.err.slice(-2)).toEqual([
          `spindle: aborting thread ${thread}`,
          `spindle: idle (aborted_by_user) after 1 step, thread ${thread}`,
        ])
        const store = yield* Effect.provide(threadStore, yield* Layer.build(storeAt(db)))
        const stored = (yield* store.getMessages(thread, { order: "asc", includeSilent: true })).messages
        expect(stored.at(-1)).toMatchObject({ role: "tool", tool_status: "error", content: CLOSING.aborted })
        expect((yield* store.getThread(thread)).terminated).toBeNull()
        const next = yield* spindle(gate, ["send", thread, "-m", "next", ...project, "--db", db])
        expect(yield* next.exit).toBe(0)
        expect(next.out).toEqual(["ack: next"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "two processes run two threads at the same time",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-model"))
        const one = yield* spindle(gate, ["run", "assistant", "-m", "one", ...project, "--db", db])
        const two = yield* spindle(gate, ["run", "assistant", "-m", "two", ...project, "--db", db])
        yield* until(
          "both processes to be inside a model call at once",
          Effect.map(entries(gate), (names) => names.filter((name) => name.startsWith("model-entered-")).length === 2),
        )
        expect((yield* entries(gate)).filter((name) => name.startsWith("model-left-"))).toEqual([])
        yield* touch(at("release-model"))
        expect([yield* one.exit, yield* two.exit]).toEqual([0, 0])
        expect([one.out, two.out]).toEqual([["ack: one"], ["ack: two"]])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )
})
