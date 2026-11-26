import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { PlatformLive, SqliteLive } from "#platform"
import { CLOSING } from "../../src/execution/run-status.ts"
import {
  call,
  callLine,
  chat,
  fixture,
  linesOf,
  messagesOf,
  note,
  printed,
  prompt,
  queuedIn,
  requesters,
  shell,
  spindleWith,
  statusOf,
  threadOf,
} from "./chat-process.ts"
import { exists, lines, query, setup, touch, until } from "./processes.ts"

// A chat shares its thread with other processes, its database with other writers, and its output with whatever
// reads it. Each test below makes one of them misbehave while the chat is at a known point.
const queue = fixture("queue")
const dir = ["--dir", queue]

const toolRows = (db: string, thread: string) =>
  Effect.map(
    query(db, "SELECT tool_status, content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY seq", [thread]),
    (rows) => rows.map((row) => [row.tool_status, row.content]),
  )

describe("spindle chat beside other processes", () => {
  it.live(
    "a message that spindle send delivers during the chat's run prints as elsewhere, and only the chat calls the model (O7, F22)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const session = yield* chat(gate, ["assistant", ...dir, "--db", db])
        const line = call("hold", { name: "a" })
        yield* session.type(`${line}\n`)
        yield* until("the tool to start", exists(at("tool-entered-a")))
        const thread = yield* threadOf(session)
        const other = yield* spindleWith(gate, ["send", thread, "-m", "beta", ...dir, "--db", db])
        yield* until(
          "the other process to queue its message",
          Effect.sync(() => other.err().includes("so the message waits in its queue")),
        )
        expect(yield* requesters(gate)).toEqual([session.pid])
        yield* touch(at("release-a"))
        yield* prompt(session, 2)
        expect(yield* other.exit).toBe(0)
        expect(linesOf(session.out())).toEqual([
          `> ${line}`,
          callLine("hold", { name: "a" }),
          "[tool result] hold ok",
          "[elsewhere] beta",
          "ack: beta",
        ])
        expect(yield* requesters(gate)).toEqual([session.pid, session.pid])
        expect(yield* messagesOf(db, thread)).toEqual([
          ["user", line],
          ["assistant", null],
          ["tool", "success"],
          ["user", "beta"],
          ["assistant", "ack: beta"],
        ])
        yield* session.end
        expect(yield* session.exit).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a run that another process made while the chat sat at the prompt prints with the next line, and nothing prints before (O7, F23)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const session = yield* chat(gate, ["assistant", ...dir, "--db", db])
        yield* session.type("one\n")
        yield* prompt(session, 2)
        const thread = yield* threadOf(session)
        const atPrompt = session.out()
        const other = yield* spindleWith(gate, ["send", thread, "-m", "beta", ...dir, "--db", db])
        expect(yield* other.exit).toBe(0)
        expect(linesOf(other.out())).toEqual(["ack: beta"])
        expect(session.out()).toBe(atPrompt)
        yield* session.type("gamma\n")
        yield* prompt(session, 3)
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual([
          "> one",
          "ack: one",
          "> gamma",
          "[elsewhere] beta",
          "ack: beta",
          "ack: gamma",
          "> ",
        ])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a chat started on a thread that another process runs says so, queues its line, and prints the reply that process made (O2, O11, F03)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const holder = yield* spindleWith(gate, [
          "run",
          "assistant",
          "-m",
          call("hold", { name: "a" }),
          ...dir,
          "--db",
          db,
        ])
        const thread = yield* threadOf(holder)
        yield* until("the tool to start", exists(at("tool-entered-a")))
        const session = yield* chat(gate, ["assistant", "--thread", thread, ...dir, "--db", db])
        yield* prompt(session, 1)
        expect(linesOf(session.err())).toEqual([note.thread(thread), note.heldAtStart(holder.pid)])
        yield* session.type("beta\n")
        yield* printed("that says why the line waits", session.err, note.behindProcess(thread, holder.pid))
        expect(yield* queuedIn(db, thread)).toHaveLength(1)
        expect(yield* requesters(gate)).toEqual([holder.pid])
        yield* touch(at("release-a"))
        yield* prompt(session, 2)
        expect(yield* holder.exit).toBe(0)
        // The holder took the queued line into its own run, so the chat made no request of its own.
        expect(yield* requesters(gate)).toEqual([holder.pid, holder.pid])
        expect(linesOf(session.out())).toEqual(["> beta", "[tool result] hold ok", "ack: beta"])
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.err())).toEqual([
          note.thread(thread),
          note.heldAtStart(holder.pid),
          note.behindProcess(thread, holder.pid),
          note.resume("assistant", thread, db, queue),
        ])
        expect(yield* lines(at("tool-log"))).toEqual(["a"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a chat started on a thread whose process was killed reports the lost run, runs the next line, and runs no tool again (O2, F04)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const lost = yield* spindleWith(gate, [
          "run",
          "assistant",
          "-m",
          call("hold", { name: "a" }),
          ...dir,
          "--db",
          db,
        ])
        const thread = yield* threadOf(lost)
        yield* until("the tool to start", exists(at("tool-entered-a")))
        yield* lost.signal("SIGKILL")
        yield* lost.exit
        const session = yield* chat(gate, ["assistant", "--thread", thread, ...dir, "--db", db])
        yield* prompt(session, 1)
        expect(linesOf(session.err())).toEqual([note.thread(thread), note.status("failed", "execution_lost")])
        yield* session.type("next\n")
        yield* session.end
        expect(yield* session.exit).toBe(0)
        // The result that the repair stored is history, so it does not print.
        expect(linesOf(session.out())).toEqual(["> next", "ack: next", "> "])
        expect(yield* toolRows(db, thread)).toEqual([["error", CLOSING.lost]])
        expect(yield* lines(at("tool-log"))).toEqual(["a"])
        expect(yield* statusOf(db, thread)).toEqual(["idle", "stop_on_response"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a line typed while another writer locks the database is refused with a note, and the next line works (O12, F10)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const session = yield* chat(gate, ["assistant", ...dir, "--db", db])
        yield* session.type("one\n")
        yield* prompt(session, 2)
        const thread = yield* threadOf(session)
        const sql = yield* Effect.provide(
          Effect.gen(function* () {
            return yield* SqlClient
          }),
          yield* Layer.build(Layer.fresh(SqliteLive({ filename: db }))),
        )
        yield* sql.unsafe("BEGIN IMMEDIATE")
        yield* session.type("locked\n")
        // The driver waits 5 seconds for the lock before it gives up, so this line takes that long to show.
        yield* printed("that refuses the line", session.err, /^spindle: the line was not sent: ./)
        yield* sql.unsafe("COMMIT")
        yield* prompt(session, 3)
        expect(yield* queuedIn(db, thread)).toEqual([])
        yield* session.type("after\n")
        yield* prompt(session, 4)
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual(["> one", "ack: one", "> locked", "> after", "ack: after", "> "])
        expect(yield* messagesOf(db, thread)).toEqual([
          ["user", "one"],
          ["assistant", "ack: one"],
          ["user", "after"],
          ["assistant", "ack: after"],
        ])
        expect(linesOf(session.err()).at(-1)).toBe(note.resume("assistant", thread, db, queue))
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    90_000,
  )

  it.live(
    "when the reader of standard output goes away, the chat settles the run, prints the resume line, and exits 1 (O16, F25)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        // The reader takes one line and closes its end of the pipe once the test says so, which is after the tool
        // started. The next line the command prints is the tool's result, so that write is the one that fails. The
        // command's own exit code goes to a file, because the exit code of a pipeline is the reader's.
        const reader =
          'read line; echo "$line"; while [ ! -e "$SPINDLE_GATE_DIR/close-reader" ]; do sleep 0.05; done; exec 0<&-; : > "$SPINDLE_GATE_DIR/reader-closed"'
        const script = `( "$@"; echo $? > "$SPINDLE_GATE_DIR/chat-exit" ) | { ${reader}; }`
        const session = yield* shell(gate, script, ["chat", "assistant", ...dir, "--db", db])
        yield* session.type(`${call("hold", { name: "a", watch: true })}\n`)
        yield* until("the tool to start", exists(at("tool-entered-a")))
        yield* touch(at("close-reader"))
        yield* until("the reader to close its end", exists(at("reader-closed")))
        const thread = yield* threadOf(session)
        yield* touch(at("release-a"))
        yield* until("the command to exit", exists(at("chat-exit")))
        expect(yield* lines(at("chat-exit"))).toEqual(["1"])
        yield* session.end
        yield* session.exit
        const notes = linesOf(session.err())
        expect(notes.slice(-2)).toEqual([note.outputClosed, note.resume("assistant", thread, db, queue)])
        expect(notes.filter((line) => /^\s+at /.test(line))).toEqual([])
        expect((yield* statusOf(db, thread))[0]).toBe("idle")
        expect(yield* toolRows(db, thread)).toEqual([["success", "released a, aborted false"]])
        expect(yield* exists(at("tool-aborted-a"))).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )
})
