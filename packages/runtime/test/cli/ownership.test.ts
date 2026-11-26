import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { PlatformLive } from "#platform"
import {
  type Child,
  entries,
  exists,
  freeze,
  lines,
  probe,
  project,
  query,
  resume,
  setup,
  spawn,
  spindle,
  stored,
  threadIn,
  touch,
  until,
} from "./processes.ts"

const DAY_MS = 24 * 60 * 60 * 1000

const call = (name: string, args: Record<string, unknown>) => `call:${JSON.stringify([{ name, arguments: args }])}`

// The lines that spindle recover prints on standard output.
const wouldRecover = (thread: string, pid: number) =>
  `thread ${thread} is running in process ${pid}, which is alive. Nothing changed. Run again with --force to settle the thread as failed (execution_lost).`
const recovered = (thread: string, pid: number) =>
  `thread ${thread} was running in process ${pid}. Settled it as failed (execution_lost). That process can write nothing more to the thread.`
const notRunning = (thread: string, status: string) => `thread ${thread} is not running (${status}). Nothing changed.`

// The last line that a process prints on standard error when it finds that its thread was taken from it.
const lostThread = (thread: string) =>
  `spindle: lost thread ${thread}: another process recovered it by force, so this process stopped working on it`

const status = (gate: string, db: string, thread: string, clockShiftMs?: number) =>
  Effect.gen(function* () {
    const child = yield* spindle(
      gate,
      ["status", thread, "--db", db],
      clockShiftMs === undefined ? {} : { clockShiftMs },
    )
    return { exit: yield* child.exit, out: child.out }
  })

const takeFromLiveProcess = (gate: string, db: string, thread: string) =>
  Effect.gen(function* () {
    const recover = yield* spindle(gate, ["recover", thread, "--force", "--db", db])
    expect(yield* recover.exit).toBe(0)
    const after = yield* status(gate, db, thread)
    expect(after.out[0]).toMatch(/^failed execution_lost since /)
  })

describe("spindle ownership across processes", () => {
  it.live("recover names a missing thread in one line", () =>
    Effect.gen(function* () {
      const { gate, db } = yield* setup
      const child = yield* spindle(gate, ["recover", "absent", "--db", db])
      expect([yield* child.exit, child.out, child.err]).toEqual([1, [], [`spindle: no thread absent in ${db}`]])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )
  it.live(
    "a status read settles a thread whose process was killed as lost at once, even with a clock that is a day behind",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-model"))
        const lost = yield* spindle(gate, ["run", "assistant", "-m", "first", ...project, "--db", db])
        const thread = yield* threadIn(lost)
        yield* until(
          "the process to enter the model",
          Effect.map(entries(gate), (names) => names.some((name) => name.startsWith("model-entered-"))),
        )
        yield* lost.signal("SIGKILL")
        yield* lost.exit
        const read = yield* status(gate, db, thread, -DAY_MS)
        expect([read.exit, read.out]).toEqual([0, [expect.stringMatching(/^failed execution_lost since /), "queued 0"]])
        yield* touch(at("release-model"))
        const again = yield* spindle(gate, ["send", thread, "-m", "again", ...project, "--db", db])
        expect([yield* again.exit, again.out]).toEqual([0, ["ack: first | again"]])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "recover without force settles a thread whose process is gone",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-model"))
        const lost = yield* spindle(gate, ["run", "assistant", "-m", "first", ...project, "--db", db])
        const thread = yield* threadIn(lost)
        yield* until(
          "the process to enter the model",
          Effect.map(entries(gate), (names) => names.some((name) => name.startsWith("model-entered-"))),
        )
        yield* lost.signal("SIGKILL")
        yield* lost.exit
        const read = yield* spindle(gate, ["recover", thread, "--db", db])
        expect([yield* read.exit, read.out]).toEqual([
          0,
          [
            `thread ${thread} was running in process ${lost.pid}, which is gone. Settled it as failed (execution_lost).`,
          ],
        ])
        yield* touch(at("release-model"))
        const again = yield* spindle(gate, ["send", thread, "-m", "again", ...project, "--db", db])
        expect([yield* again.exit, again.out]).toEqual([0, ["ack: first | again"]])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a status read with a clock that is a day ahead reports running for a holder that is alive and for one it may not signal",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-model"))
        const run = yield* spindle(gate, ["run", "assistant", "-m", "first", ...project, "--db", db])
        const thread = yield* threadIn(run)
        yield* until(
          "the process to enter the model",
          Effect.map(entries(gate), (names) => names.some((name) => name.startsWith("model-entered-"))),
        )
        const alive = yield* status(gate, db, thread, DAY_MS)
        // Process 1 belongs to the system, so a probe of it from a test gets a permission error or finds it alive.
        yield* query(db, "UPDATE holders SET pid = 1")
        const foreign = yield* status(gate, db, thread, DAY_MS)
        expect([alive.out.slice(0, 2), foreign.out.slice(0, 2)]).toEqual([
          [expect.stringMatching(/^running none since /), `held by process ${run.pid}`],
          [expect.stringMatching(/^running none since /), "held by process 1"],
        ])
        yield* touch(at("release-model"))
        expect([yield* run.exit, run.out]).toEqual([0, ["ack: first"]])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "spindle recover names the live holder and changes nothing without --force, and settles the thread as lost with it",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const run = yield* spindle(gate, [
          "run",
          "assistant",
          "-m",
          call("hold", { name: "a" }),
          ...project,
          "--db",
          db,
        ])
        const thread = yield* threadIn(run)
        yield* until("the tool to start", exists(at("tool-entered-a")))
        const before = yield* stored(db, thread)
        expect(before.status).toEqual(["running", null])
        const dry = yield* spindle(gate, ["recover", thread, "--db", db])
        expect([yield* dry.exit, dry.out]).toEqual([0, [wouldRecover(thread, run.pid)]])
        expect(yield* stored(db, thread)).toEqual(before)
        const forced = yield* spindle(gate, ["recover", thread, "--force", "--db", db])
        expect([yield* forced.exit, forced.out]).toEqual([0, [recovered(thread, run.pid)]])
        const after = yield* stored(db, thread)
        expect([after.status, after.flow, after.messages.map((message) => message[0])]).toEqual([
          ["failed", "execution_lost"],
          null,
          ["user", "assistant", "tool"],
        ])
        const again = yield* spindle(gate, ["recover", thread, "--force", "--db", db])
        expect([yield* again.exit, again.out]).toEqual([0, [notRunning(thread, "failed execution_lost")]])
        yield* touch(at("release-a"))
        yield* run.exit
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "spindle recover changes nothing on a thread that is not running, with or without --force, and says so",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const first = yield* spindle(gate, ["run", "assistant", "-m", "setup", ...project, "--db", db])
        expect(yield* first.exit).toBe(0)
        const thread = yield* threadIn(first)
        const before = yield* stored(db, thread)
        for (const flags of [[], ["--force"]]) {
          const recover = yield* spindle(gate, ["recover", thread, ...flags, "--db", db])
          expect([yield* recover.exit, recover.out]).toEqual([0, [notRunning(thread, "idle stop_on_response")]])
        }
        expect(yield* stored(db, thread)).toEqual(before)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a frozen process whose thread was recovered by force writes nothing once it resumes, says that it lost the thread, and fails",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const old = yield* spindle(gate, [
          "run",
          "assistant",
          "-m",
          call("late", { name: "l" }),
          ...project,
          "--db",
          db,
        ])
        const thread = yield* threadIn(old)
        yield* until("the tool to start", exists(at("tool-entered-l")))
        yield* freeze(old)
        yield* takeFromLiveProcess(gate, db, thread)
        const successor = yield* spindle(gate, ["send", thread, "-m", "second", ...project, "--db", db])
        expect([yield* successor.exit, successor.out]).toEqual([0, ["ack: second"]])
        const before = yield* stored(db, thread)
        yield* touch(at("release-l"))
        yield* resume(old)
        const code = yield* old.exit
        const outcomes = (yield* exists(at("late-l.log"))) ? yield* lines(at("late-l.log")) : []
        const refused = (write: string) => expect.stringMatching(new RegExp(`^${write} refused [A-Z][A-Za-z]+$`))
        // The process stops when it sees that it lost the thread, which can be before the tool has tried every write.
        // So each write it did try must have been refused. Scenario O01 checks all six in one process.
        const writes = ["setValue", "queueMessage", "injectMessage", "updateMessage", "deleteMessage", "terminate"]
        expect({
          outcomes,
          stored: yield* stored(db, thread),
          failed: code !== 0,
          lastLine: old.err.at(-1),
          reportedAnOutcome: old.err.filter((line) => /^spindle: (idle|failed) \(/.test(line)),
        }).toEqual({
          outcomes: writes.slice(0, outcomes.length).map(refused),
          stored: before,
          failed: true,
          lastLine: lostThread(thread),
          reportedAnOutcome: [],
        })
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a process killed in the middle of a drain leaves each queued entry once, in the queue or in the history",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-model"))
        const run = yield* spindle(gate, ["run", "assistant", "-m", "first", ...project, "--db", db])
        const thread = yield* threadIn(run)
        yield* until(
          "the process to enter the model",
          Effect.map(entries(gate), (names) => names.some((name) => name.startsWith("model-entered-"))),
        )
        const queue = (args: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const child = yield* spawn(gate, probe, [...args, "--thread", thread, ...project, "--db", db])
            expect(yield* child.exit).toBe(0)
          })
        yield* queue(["queue-message", "--role", "user", "--content", "M1"])
        yield* queue(["queue-tool", "--tool", "hold", "--args", JSON.stringify({ name: "k" })])
        yield* queue(["queue-message", "--role", "user", "--content", "M2"])
        yield* touch(at("release-model"))
        yield* until("the queued tool to start", exists(at("tool-entered-k")))
        yield* run.signal("SIGKILL")
        yield* run.exit
        const cut = yield* stored(db, thread)
        expect([cut.messages, cut.queue.map((entry) => entry[0])]).toEqual([
          [
            ["user", "first"],
            ["assistant", "ack: first"],
            ["user", "M1"],
            ["assistant", null],
          ],
          ["message"],
        ])
        expect(String(cut.queue[0]?.[1])).toContain("M2")
        const read = (child: { readonly out: ReadonlyArray<string> }) => child.out[0] ?? ""
        yield* until(
          "an observer to settle the run as lost",
          Effect.gen(function* () {
            const child = yield* spindle(gate, ["status", thread, "--db", db])
            yield* child.exit
            return read(child).startsWith("failed execution_lost")
          }),
        )
        const after = yield* spindle(gate, ["send", thread, "-m", "after", ...project, "--db", db])
        expect([yield* after.exit, after.out]).toEqual([0, ["ack: M2 | after"]])
        const end = yield* stored(db, thread)
        expect([end.messages, end.queue]).toEqual([
          [
            ["user", "first"],
            ["assistant", "ack: first"],
            ["user", "M1"],
            ["assistant", null],
            ["tool", "error"],
            ["user", "M2"],
            ["user", "after"],
            ["assistant", "ack: M2 | after"],
          ],
          [],
        ])
        expect(yield* lines(at("tool-log"))).toEqual(["k"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a send that waits behind a run in another process fails when a third process terminates the thread",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const run = yield* spindle(gate, [
          "run",
          "assistant",
          "-m",
          call("hold", { name: "t", watch: true }),
          ...project,
          "--db",
          db,
        ])
        const thread = yield* threadIn(run)
        yield* until("the tool to start", exists(at("tool-entered-t")))
        const waiting: Child = yield* spindle(gate, ["send", thread, "-m", "waiting", ...project, "--db", db])
        yield* until(
          "the send to queue",
          Effect.sync(() => waiting.err.some((line) => line.includes("waits in its queue"))),
        )
        const terminate = yield* spawn(gate, probe, ["terminate", "--thread", thread, ...project, "--db", db])
        expect(yield* terminate.exit).toBe(0)
        expect([yield* waiting.exit, waiting.err.at(-1)]).toEqual([
          1,
          `spindle: thread ${thread} is terminated, so it takes no new message, queued work, or execution`,
        ])
        expect(waiting.out).toEqual([])
        yield* run.exit
        expect((yield* stored(db, thread)).messages.map((message) => message[0])).toEqual(["user", "assistant", "tool"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )
})
