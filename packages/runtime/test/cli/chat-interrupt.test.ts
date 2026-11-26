import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { PlatformLive } from "#platform"
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
  type Session,
  screen,
  spindleWith,
  statusOf,
  threadOf,
} from "./chat-process.ts"
import { entries, exists, lines, query, setup, touch, until } from "./processes.ts"

// Ctrl-C and end of input at each point of the loop. A test sends SIGINT to the command, which is what a terminal
// does for Ctrl-C while a line is not being edited. The two terminal tests type the keys instead.
const queue = fixture("queue")

const toolRows = (db: string, thread: string) =>
  Effect.map(
    query(db, "SELECT tool_status, content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY seq", [thread]),
    (rows) => rows.map((row) => [row.tool_status, row.content]),
  )

// Starts a chat, asks for one call of the hold tool, and waits until the tool runs.
const holding = (gate: string, db: string, at: (name: string) => string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
    const line = call("hold", args)
    yield* session.type(`${line}\n`)
    yield* until("the tool to start", exists(at(`tool-entered-${args.name}`)))
    return { session, line, thread: yield* threadOf(session) }
  })

// Two Ctrl-C in one run. The second is sent only after the command answered the first.
const abort = (session: Session) =>
  Effect.gen(function* () {
    yield* session.signal("SIGINT")
    yield* printed("that answers the first Ctrl-C", session.err, note.stopping)
    yield* session.signal("SIGINT")
    yield* printed("that answers the second Ctrl-C", session.err, note.aborting)
    yield* prompt(session, 2)
  })

describe("spindle chat and Ctrl-C", () => {
  it.live(
    "two consecutive aborted tools release both queued turns",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const { session, thread } = yield* holding(gate, db, at, { name: "first" })
        yield* abort(session)
        yield* session.type(`${call("hold", { name: "second" })}\n`)
        yield* printed("the first wait", session.err, note.behindTool("hold"))
        yield* touch(at("release-first"))
        yield* until("the second tool to start", exists(at("tool-entered-second")))
        yield* session.signal("SIGINT")
        yield* until(
          "the second stop",
          Effect.sync(() => linesOf(session.err()).filter((line) => line === note.stopping).length === 2),
        )
        yield* session.signal("SIGINT")
        yield* prompt(session, 3)
        yield* session.type("third\n")
        yield* until(
          "the second wait",
          Effect.sync(() => linesOf(session.err()).filter((line) => line === note.behindTool("hold")).length === 2),
        )
        yield* touch(at("release-second"))
        yield* prompt(session, 4)
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out()).filter((line) => line === "ack: third")).toHaveLength(1)
        expect(linesOf(session.err()).filter((line) => line === note.status("idle", "aborted_by_user"))).toHaveLength(2)
        expect(yield* toolRows(db, thread)).toEqual([
          ["error", CLOSING.aborted],
          ["error", CLOSING.aborted],
        ])
        expect(yield* lines(at("tool-log"))).toEqual(["first", "second"])
        expect(yield* queuedIn(db, thread)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "an aborted hook is named while it holds the thread",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-hook"))
        const session = yield* chat(gate, ["hooked", "--dir", queue, "--db", db])
        yield* session.type(`${call("echo", { text: "hi" })}\n`)
        yield* until("the hook to enter", exists(at("hook-entered")))
        yield* abort(session)
        yield* session.type("next\n")
        yield* until(
          "the wait note",
          Effect.sync(() => session.err().includes("so the line waits")),
        )
        expect(linesOf(session.err()).at(-1)).toBe(
          "spindle: hook gate_store has not returned since the abort, so the line waits in the queue until it does",
        )
        yield* touch(at("release-hook"))
        yield* prompt(session, 3)
        yield* session.end
        expect(yield* session.exit).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "exit reports durable queued admissions even when a signal races the sender",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const holder = yield* spindleWith(gate, [
          "run",
          "assistant",
          "-m",
          call("hold", { name: "busy" }),
          "--dir",
          queue,
          "--db",
          db,
        ])
        yield* until("the holder to enter the tool", exists(at("tool-entered-busy")))
        const thread = yield* threadOf(holder)
        for (const signal of ["SIGTERM", "SIGINT"] as const) {
          const session = yield* chat(gate, ["assistant", "--thread", thread, "--dir", queue, "--db", db])
          yield* prompt(session, 1)
          yield* session.type(`${signal}\n`)
          if (signal === "SIGTERM") yield* printed("waiting", session.err, note.behindProcess(thread, holder.pid))
          yield* session.signal(signal)
          expect(yield* session.exit).toBe(signal === "SIGTERM" ? 130 : 0)
          const admitted = (yield* queuedIn(db, thread)).some((row) => row.includes(signal))
          expect(linesOf(session.err()).includes(note.stillQueued)).toBe(admitted)
        }
        yield* touch(at("release-busy"))
        expect(yield* holder.exit).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "termination signals print the resume line at the second prompt",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        for (const signal of ["SIGTERM", "SIGHUP"] as const) {
          const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
          yield* session.type("one\n")
          yield* prompt(session, 2)
          const thread = yield* threadOf(session)
          yield* session.signal(signal)
          expect(yield* session.exit).toBe(130)
          expect(linesOf(session.err()).at(-1)).toBe(note.resume("assistant", thread, db, queue))
        }
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "Ctrl-C at the prompt ends the line, prints the resume line, and exits 0 (lane 5, O14, F05)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db], { view: "merged" })
        yield* session.type("one\n")
        yield* prompt(session, 2)
        yield* session.signal("SIGINT")
        expect(yield* session.exit).toBe(0)
        const thread = yield* threadOf(session)
        expect(linesOf(session.out())).toEqual([
          note.thread(thread),
          "> one",
          "ack: one",
          "> ",
          note.resume("assistant", thread, db, queue),
        ])
        expect(yield* statusOf(db, thread)).toEqual(["idle", "stop_on_response"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "end of input during a run lets the run finish, prints its reply, and then exits 0 (F14)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-model"))
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
        yield* session.type("one\n")
        yield* session.end
        yield* until(
          "the model call to start",
          Effect.map(entries(gate), (names) => names.some((name) => name.startsWith("model-entered-"))),
        )
        yield* touch(at("release-model"))
        expect(yield* session.exit).toBe(0)
        const thread = yield* threadOf(session)
        expect(linesOf(session.out())).toEqual(["> one", "ack: one", "> "])
        expect(linesOf(session.err())).toEqual([note.thread(thread), note.resume("assistant", thread, db, queue)])
        // The model call saw no abort when it returned.
        expect(yield* lines(at(`model-left-${session.pid}-1`))).toEqual(["false"])
        expect(yield* messagesOf(db, thread)).toEqual([
          ["user", "one"],
          ["assistant", "ack: one"],
        ])
        expect(yield* statusOf(db, thread)).toEqual(["idle", "stop_on_response"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "the first Ctrl-C in a run lets the tool finish without an abort, stops before the next model call, and returns the prompt (lane 4, O8, O10, F15)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db], { view: "merged" })
        const line = call("hold", { name: "a", watch: true })
        yield* session.type(`${line}\n`)
        yield* until("the tool to start", exists(at("tool-entered-a")))
        yield* session.signal("SIGINT")
        yield* printed("that answers Ctrl-C", session.out, note.stopping)
        yield* touch(at("release-a"))
        yield* prompt(session, 2)
        const thread = yield* threadOf(session)
        expect(yield* exists(at("tool-aborted-a"))).toBe(false)
        expect(yield* toolRows(db, thread)).toEqual([["success", "released a, aborted false"]])
        expect(yield* requesters(gate)).toHaveLength(1)
        const status = yield* spindleWith(gate, ["status", thread, "--db", db])
        expect(yield* status.exit).toBe(0)
        expect(linesOf(status.out())[0]).toMatch(/^idle aborted_by_user since /)
        yield* session.type("next\n")
        yield* prompt(session, 3)
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual([
          note.thread(thread),
          `> ${line}`,
          callLine("hold", { name: "a", watch: true }),
          note.stopping,
          "[tool result] hold ok",
          note.status("idle", "aborted_by_user"),
          "> next",
          "ack: next",
          "> ",
          note.resume("assistant", thread, db, queue),
        ])
        expect(yield* lines(at("tool-log"))).toEqual(["a"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "the second Ctrl-C aborts a tool that watches the signal, and the next line prints the closing result and its reply (O9, O10, F16)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const { session, line, thread } = yield* holding(gate, db, at, { name: "b", watch: true })
        yield* abort(session)
        yield* until("the tool to see the abort", exists(at("tool-aborted-b")))
        // The line below is typed only once the aborted run has settled, so it waits behind nothing.
        yield* until(
          "the aborted run to settle",
          Effect.map(statusOf(db, thread), ([state]) => state === "idle"),
        )
        expect(yield* statusOf(db, thread)).toEqual(["idle", "aborted_by_user"])
        yield* session.type("next\n")
        yield* prompt(session, 3)
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual([
          `> ${line}`,
          callLine("hold", { name: "b", watch: true }),
          "> next",
          expect.stringMatching(/^\[tool result\] hold error: ./),
          "ack: next",
          "> ",
        ])
        expect(linesOf(session.err())).toEqual([
          note.thread(thread),
          note.stopping,
          note.aborting,
          note.status("idle", "aborted_by_user"),
          note.resume("assistant", thread, db, queue),
        ])
        expect((yield* toolRows(db, thread)).map(([status]) => status)).toEqual(["error"])
        expect(yield* lines(at("tool-log"))).toEqual(["b"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "after an abort that a tool ignores, a typed line waits with a note until the tool returns, and the tool runs once (O11, F17)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const { session, line, thread } = yield* holding(gate, db, at, { name: "b" })
        yield* abort(session)
        expect(yield* statusOf(db, thread)).toEqual(["running", null])
        yield* session.type("next\n")
        yield* printed("that says why the line waits", session.err, note.behindTool("hold"))
        expect(yield* queuedIn(db, thread)).toHaveLength(1)
        expect(yield* requesters(gate)).toHaveLength(1)
        expect(yield* toolRows(db, thread)).toEqual([])
        yield* touch(at("release-b"))
        yield* prompt(session, 3)
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual([
          `> ${line}`,
          callLine("hold", { name: "b" }),
          "> next",
          `[tool result] hold error: ${CLOSING.aborted}`,
          "ack: next",
          "> ",
        ])
        expect(linesOf(session.err())).toEqual([
          note.thread(thread),
          note.stopping,
          note.aborting,
          note.behindTool("hold"),
          note.status("idle", "aborted_by_user"),
          note.resume("assistant", thread, db, queue),
        ])
        // The late return of the tool changed nothing, and the tool did not run again.
        expect(yield* toolRows(db, thread)).toEqual([["error", CLOSING.aborted]])
        expect(yield* lines(at("tool-log"))).toEqual(["b"])
        expect(yield* messagesOf(db, thread)).toEqual([
          ["user", line],
          ["assistant", null],
          ["tool", "error"],
          ["user", "next"],
          ["assistant", "ack: next"],
        ])
        expect(yield* statusOf(db, thread)).toEqual(["idle", "stop_on_response"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "three Ctrl-C end a chat whose tool never returns, and a resumed chat gets a reply (O14, F18)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const { session, line, thread } = yield* holding(gate, db, at, { name: "b" })
        yield* abort(session)
        yield* session.signal("SIGINT")
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual([`> ${line}`, callLine("hold", { name: "b" }), "> "])
        expect(linesOf(session.err())).toEqual([
          note.thread(thread),
          note.stopping,
          note.aborting,
          note.resume("assistant", thread, db, queue),
        ])
        expect(yield* statusOf(db, thread)).toEqual(["idle", "aborted_by_user"])
        expect(yield* toolRows(db, thread)).toEqual([["error", CLOSING.aborted]])
        const resumed = yield* chat(gate, ["assistant", "--thread", thread, "--dir", queue, "--db", db])
        yield* resumed.type("after\n")
        yield* resumed.end
        expect(yield* resumed.exit).toBe(0)
        expect(linesOf(resumed.err()).slice(0, 2)).toEqual([
          note.thread(thread),
          note.status("idle", "aborted_by_user"),
        ])
        expect(linesOf(resumed.out())).toEqual(["> after", "ack: after", "> "])
        expect(yield* lines(at("tool-log"))).toEqual(["b"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "Ctrl-C while a line waits exits 0 with the queued note, and the next chat delivers the line once (O13, F19)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const { session, thread } = yield* holding(gate, db, at, { name: "b" })
        yield* abort(session)
        yield* session.type("next\n")
        yield* printed("that says why the line waits", session.err, note.behindTool("hold"))
        yield* session.signal("SIGINT")
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.err()).slice(-2)).toEqual([
          note.stillQueued,
          note.resume("assistant", thread, db, queue),
        ])
        const queued = yield* queuedIn(db, thread)
        expect(queued).toHaveLength(1)
        expect(queued[0]).toContain("next")
        expect((yield* messagesOf(db, thread)).filter(([role]) => role === "user")).toHaveLength(1)
        const resumed = yield* chat(gate, ["assistant", "--thread", thread, "--dir", queue, "--db", db])
        yield* resumed.type("later\n")
        yield* resumed.end
        expect(yield* resumed.exit).toBe(0)
        expect(linesOf(resumed.out())).toEqual(["> later", "[elsewhere] next", "ack: next | later", "> "])
        expect((yield* messagesOf(db, thread)).slice(3)).toEqual([
          ["user", "next"],
          ["user", "later"],
          ["assistant", "ack: next | later"],
        ])
        expect(yield* queuedIn(db, thread)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  // The two tests below need a pseudo-terminal. A key typed at a terminal reaches the command as a signal or as a
  // byte, which depends on the mode the command put the terminal in, and a pipe has no such mode.
  const visible = (session: Session) => screen(session.out())
  const lastLine = (text: string) =>
    linesOf(text)
      .filter((line) => line.trim() !== "")
      .at(-1)

  it.live(
    "in a terminal a typed line shows once, and Ctrl-C at the prompt prints the resume line and exits 0 (F05, F09)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db], { view: "terminal" })
        const thread = yield* threadOf(session)
        yield* until(
          "the first prompt",
          Effect.sync(() => visible(session).endsWith("> ")),
        )
        yield* session.type("one\n")
        yield* until(
          "the reply and the next prompt",
          Effect.sync(() => visible(session).includes("ack: one") && visible(session).endsWith("> ")),
        )
        // The terminal echoes the keys. A second copy would be the command's own echo, which is for a pipe only.
        expect(visible(session).split("one").length - 1).toBe(2)
        yield* session.type("\u0003")
        expect(yield* session.exit).toBe(0)
        expect(lastLine(visible(session))).toBe(note.resume("assistant", thread, db, queue))
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "in a terminal Ctrl-C in a run stops it without an abort, and Ctrl-D at the prompt exits 0 (F05, F09, F15)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db], { view: "terminal" })
        const thread = yield* threadOf(session)
        yield* until(
          "the first prompt",
          Effect.sync(() => visible(session).endsWith("> ")),
        )
        yield* session.type(`${call("hold", { name: "a", watch: true })}\n`)
        yield* until("the tool to start", exists(at("tool-entered-a")))
        yield* session.type("\u0003")
        yield* until(
          "the line that answers Ctrl-C",
          Effect.sync(() => visible(session).includes(note.stopping)),
        )
        yield* touch(at("release-a"))
        yield* until(
          "the stopped run and the next prompt",
          Effect.sync(
            () => visible(session).includes(note.status("idle", "aborted_by_user")) && visible(session).endsWith("> "),
          ),
        )
        expect(visible(session)).toContain("[tool result] hold ok")
        expect(yield* exists(at("tool-aborted-a"))).toBe(false)
        expect(yield* toolRows(db, thread)).toEqual([["success", "released a, aborted false"]])
        yield* session.type("\u0004")
        expect(yield* session.exit).toBe(0)
        expect(lastLine(visible(session))).toBe(note.resume("assistant", thread, db, queue))
        expect(yield* statusOf(db, thread)).toEqual(["idle", "aborted_by_user"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )
})
