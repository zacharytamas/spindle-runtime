import { describe, expect, it } from "@effect/vitest"
import { Clock, Effect, FileSystem } from "effect"
import { PlatformLive } from "#platform"
import {
  call,
  callLine,
  chat,
  conformanceModules,
  fixture,
  linesOf,
  messagesOf,
  note,
  printed,
  prompt,
  requesters,
  requestOf,
  shell,
  spindleWith,
  statusOf,
  threadOf,
} from "./chat-process.ts"
import { exists, probe, project, query, setup, spawn, stored, touch, until } from "./processes.ts"

// Each test runs the real command and reads what it prints. docs/plans/briefs/m1-7.md names the lines (O) and the
// failures (F) that the titles cite.
const queue = fixture("queue")
const stepLoop = fixture("step-loop")
const hooks = fixture("hooks")

const write = (file: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(file, text))

const threadsIn = (db: string) =>
  Effect.gen(function* () {
    return (yield* exists(db)) ? yield* query(db, "SELECT id FROM threads") : []
  })

describe("spindle chat", () => {
  it.live(
    "successful results show one line of stored content with an optional full preview",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const boundary = "😀".repeat(200)
        const content = `${boundary}\nextra\u202e`
        for (const full of [false, true]) {
          const session = yield* chat(gate, [
            "assistant",
            "--dir",
            queue,
            "--db",
            db,
            ...(full ? ["--full-results"] : []),
          ])
          for (const text of ["", boundary, content]) yield* session.type(`${call("echo", { text })}\n`)
          yield* session.end
          expect(yield* session.exit).toBe(0)
          expect(linesOf(session.out()).filter((line) => line.startsWith("[tool result]"))).toEqual([
            "[tool result] echo ok",
            `[tool result] echo ok: ${boundary}`,
            `[tool result] echo ok: ${boundary}${full ? " extra\\u202e" : "..."}`,
          ])
          const rows = yield* query(
            db,
            "SELECT content FROM messages WHERE thread_id = ? AND role = 'tool' ORDER BY seq",
            [yield* threadOf(session)],
          )
          expect(rows.map((row) => row.content)).toEqual(["", boundary, content])
        }
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a deleted database gets one plain diagnostic when the next line arrives",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const fs = yield* FileSystem.FileSystem
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
        yield* session.type("first\n")
        yield* prompt(session, 2)
        const thread = yield* threadOf(session)
        yield* fs.remove(db)
        yield* session.type("second\n")
        yield* session.end
        expect(yield* session.exit).toBe(1)
        expect(linesOf(session.err())).toEqual([note.thread(thread), `spindle: the database ${db} is gone`])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "direction controls are escaped on the terminal and preserved in history",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const text = "left\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069right"
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
        yield* session.type(`${text}\n${call("echo", { text })}\n`)
        yield* session.end
        expect(yield* session.exit).toBe(0)
        const escaped = String.raw`left\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069right`
        expect(session.out()).toContain(`ack: ${escaped}`)
        expect(session.out()).toContain(`[tool call] echo {"text":"${escaped}"}`)
        expect(session.out()).not.toMatch(/\p{Bidi_Control}/u)
        expect(yield* messagesOf(db, yield* threadOf(session))).toContainEqual(["assistant", `ack: ${text}`])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a declared digit preserves identifiers in the printed commands",
    () =>
      Effect.gen(function* () {
        const { gate, at } = yield* setup
        const fs = yield* FileSystem.FileSystem
        yield* fs.symlink(stepLoop, at("project"))
        const env = { REGION_HINT: "4" }
        const run = (words: string[]) => shell(gate, 'cd "$SPINDLE_GATE_DIR" && exec "$@"', words, env)
        const session = yield* run(["chat", "shaded", "--db", "chat.db", "--dir", "project"])
        yield* session.end
        expect(yield* session.exit).toBe(0)
        const thread = String((yield* threadsIn(at("chat.db")))[0]?.id)
        const notes = linesOf(session.err())
        expect(notes).toEqual([note.thread(thread), note.resume("shaded", thread, "chat.db", "project")])
        const words = notes[1]?.slice("spindle: resume with spindle ".length).split(" ") ?? []
        const resumed = yield* run([...words, "--script", "project/scripts/text-reply.json"])
        yield* resumed.type("again\n")
        yield* resumed.end
        expect(yield* resumed.exit).toBe(0)
        expect(yield* messagesOf(at("chat.db"), thread)).toContainEqual(["user", "again"])
        for (const command of ["run", "send", "status", "recover"]) {
          const words = command === "run" ? ["run", "shaded"] : [command, thread]
          if (command === "run" || command === "send")
            words.push("-m", "next", "--dir", "project", "--script", "project/scripts/text-reply.json")
          const result = yield* run([...words, "--db", "chat.db"])
          expect(yield* result.exit).toBe(0)
          if (command === "recover") expect(result.out()).toContain(thread)
          if (command === "send") expect(linesOf(result.err())[0]).toBe(note.thread(thread))
          if (command === "run") {
            const created = (yield* threadsIn(at("chat.db"))).find((row) => row.id !== thread)
            expect(linesOf(result.err())[0]).toBe(note.thread(String(created?.id)))
          }
        }
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "three lines piped at once get one turn each, and end of input prints the resume line (lane 1, O1, O3, O4, O14, F05, F08)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db], { view: "merged" })
        yield* session.type("one\ntwo\nthree\n")
        yield* session.end
        expect(yield* session.exit).toBe(0)
        const thread = yield* threadOf(session)
        expect(linesOf(session.out())).toEqual([
          note.thread(thread),
          "> one",
          "ack: one",
          "> two",
          "ack: two",
          "> three",
          "ack: three",
          "> ",
          note.resume("assistant", thread, db, queue),
        ])
        expect(yield* messagesOf(db, thread)).toEqual([
          ["user", "one"],
          ["assistant", "ack: one"],
          ["user", "two"],
          ["assistant", "ack: two"],
          ["user", "three"],
          ["assistant", "ack: three"],
        ])
        expect(yield* statusOf(db, thread)).toEqual(["idle", "stop_on_response"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "the first prompt shows within 5 seconds, after the thread line and nothing else (O1, O3)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const started = yield* Clock.currentTimeMillis
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
        yield* prompt(session, 1)
        const waited = (yield* Clock.currentTimeMillis) - started
        expect(session.out()).toBe("> ")
        expect(linesOf(session.err())).toEqual([note.thread(yield* threadOf(session))])
        expect(waited).toBeLessThan(5000)
        yield* session.end
        expect(yield* session.exit).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a tool that works prints ok, a tool that throws prints its error, and the run goes on (lane 3, O5, O6, F20)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const script = `${stepLoop}/scripts/tool-error-sibling.json`
        const session = yield* chat(gate, ["assistant", "--dir", stepLoop, "--script", script, "--db", db])
        yield* session.type("go\n")
        yield* session.end
        expect(yield* session.exit).toBe(0)
        const thread = yield* threadOf(session)
        expect(linesOf(session.out())).toEqual([
          "> go",
          "[tool call] explode {}",
          '[tool call] write_note {"key":"after","value":"still ran"}',
          "[tool result] explode error: Tool explode threw: The explode tool failed on purpose",
          "[tool result] write_note ok: Saved after",
          "The first tool failed and the second one still ran.",
          "> ",
        ])
        expect(linesOf(session.err())).toEqual([note.thread(thread), note.resume("assistant", thread, db, stepLoop)])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a call line prints while its tool still runs (O5, F13)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
        const line = call("hold", { name: "a" })
        yield* session.type(`${line}\n`)
        yield* until("the tool to start", exists(at("tool-entered-a")))
        // The test has not released the tool, so a call line that shows now was printed while the tool ran.
        yield* printed("of the call", session.out, callLine("hold", { name: "a" }))
        yield* touch(at("release-a"))
        yield* prompt(session, 2)
        expect(linesOf(session.out())).toEqual([
          `> ${line}`,
          callLine("hold", { name: "a" }),
          "[tool result] hold ok: released a, aborted false",
          "done",
        ])
        yield* session.end
        expect(yield* session.exit).toBe(0)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live("an interrupt pending inside a synchronous tool reaches the prompt after the reply", () =>
    Effect.gen(function* () {
      const { gate, db, at } = yield* setup
      const fs = yield* FileSystem.FileSystem
      const dir = at("project")
      yield* fs.copy(queue, dir)
      yield* fs.symlink(conformanceModules, `${dir}/node_modules`)
      yield* write(
        `${dir}/agents/tools/hold.ts`,
        `
        import fs from "node:fs"
        const dir = process.env.SPINDLE_GATE_DIR
        export default { description: "Block the JS thread until released", args: null, execute() {
          fs.writeFileSync(dir + "/entered", "")
          const deadline = Date.now() + 5000
          while (!fs.existsSync(dir + "/release")) {
            if (Date.now() >= deadline) throw new Error("release gate timed out")
          }
          return {status: "success", result: "released"}
        } }
      `,
      )
      const session = yield* chat(gate, ["assistant", "--dir", dir, "--db", db])
      yield* session.type(`${call("hold", {})}\n`)
      yield* until("the synchronous tool to enter", exists(at("entered")))
      yield* session.signal("SIGINT")
      yield* touch(at("release"))
      yield* session.end
      expect(yield* session.exit).toBe(0)
      const thread = yield* threadOf(session)
      expect(yield* statusOf(db, thread)).toEqual(["idle", "stop_on_response"])
      expect(linesOf(session.err())).toEqual([note.thread(thread), note.resume("assistant", thread, db, dir)])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.live(
    "the printed resume command runs as printed and its request holds the first chat's messages (lane 2, O2, O14)",
    () =>
      Effect.gen(function* () {
        const { gate, at } = yield* setup
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(at("my chats"))
        // The space makes the shell split the path unless the resume line quotes it.
        const db = at("my chats/spindle.db")
        const first = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
        yield* first.type("first\n")
        yield* first.end
        expect(yield* first.exit).toBe(0)
        const thread = yield* threadOf(first)
        const resume = linesOf(first.err()).at(-1) ?? ""
        expect(resume).toBe(note.resume("assistant", thread, db, queue))
        const words = resume.slice("spindle: resume with spindle ".length)
        const second = yield* shell(gate, `exec "$@" ${words} --dump-requests`, [])
        yield* second.type("second\n")
        yield* second.end
        expect(yield* second.exit).toBe(0)
        expect(linesOf(second.err())).toEqual([note.thread(thread), note.status("idle", "stop_on_response"), resume])
        const dumps = second.out().match(/^\{$[\s\S]*?^\}$/gm) ?? []
        expect(dumps).toHaveLength(1)
        const request = JSON.parse(dumps[0] ?? "{}") as { messages: Array<{ role: string; content: unknown }> }
        expect(request.messages.map((message) => [message.role, message.content]).slice(1)).toEqual([
          ["user", "first"],
          ["assistant", "ack: first"],
          ["user", "second"],
        ])
        expect(linesOf(second.out()).at(-2)).toBe("ack: second")
        expect(yield* messagesOf(db, thread)).toHaveLength(4)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a resumed chat reads the definitions again, so an edited prompt reaches the next request (lane 7)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const fs = yield* FileSystem.FileSystem
        const dir = at("project")
        yield* fs.copy(queue, dir)
        yield* fs.symlink(conformanceModules, `${dir}/node_modules`)
        const first = yield* chat(gate, ["assistant", "--dir", dir, "--db", db])
        yield* first.type("one\n")
        yield* first.end
        expect(yield* first.exit).toBe(0)
        const thread = yield* threadOf(first)
        const file = `${dir}/agents/prompts/assistant.ts`
        const before = yield* fs.readFileString(file)
        expect(before).toContain("You are a test assistant.")
        yield* write(file, before.replace("You are a test assistant.", "You are an edited assistant."))
        const second = yield* chat(gate, ["assistant", "--thread", thread, "--dir", dir, "--db", db])
        yield* second.type("two\n")
        yield* second.end
        expect(yield* second.exit).toBe(0)
        const requests = [yield* requestOf(gate, first.pid, 1), yield* requestOf(gate, second.pid, 1)]
        expect(requests.map((request) => request.messages[0])).toEqual([
          { role: "system", content: "You are a test assistant." },
          { role: "system", content: "You are an edited assistant." },
        ])
        expect(requests[1]?.messages.slice(1).map((message) => message.content)).toEqual(["one", "ack: one", "two"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a project with a definition error prints what spindle run prints, exits 1, and shows no prompt (lane 6, O15, F01)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const dir = fixture("invalid/both-sides-human")
        const run = yield* spindleWith(gate, ["run", "both_human", "-m", "x", "--dir", dir])
        expect(yield* run.exit).toBe(1)
        expect(linesOf(run.err())).toHaveLength(2)
        const session = yield* chat(gate, ["both_human", "--dir", dir, "--db", db])
        yield* session.end
        expect(yield* session.exit).toBe(1)
        expect(session.out()).toBe("")
        expect(linesOf(session.err())).toEqual(linesOf(run.err()))
        expect(yield* threadsIn(db)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live("opens a chat when the project has only naming warnings", () =>
    Effect.gen(function* () {
      const { gate, at } = yield* setup
      const fs = yield* FileSystem.FileSystem
      const dir = at("project")
      yield* fs.copy(fixture("invalid/naming-warnings"), dir)
      yield* write(
        `${dir}/agents/agents/chat.ts`,
        'export default {name:"chat",sideA:{prompt:"MainPrompt"},sideB:{human:true}}',
      )
      const session = yield* chat(gate, ["chat", "--dir", dir])
      yield* session.end
      expect(yield* session.exit).toBe(0)
      expect(linesOf(session.err())).toEqual([note.thread(yield* threadOf(session)), note.memory])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.live(
    "an unknown agent prints one line, exits 1, and creates no thread (O15, F01)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const session = yield* chat(gate, ["nobody", "--dir", queue, "--db", db])
        yield* session.end
        expect(yield* session.exit).toBe(1)
        expect(session.out()).toBe("")
        expect(linesOf(session.err())).toEqual(["spindle: No agent named nobody is defined"])
        expect(yield* threadsIn(db)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "--thread fails before the prompt for a missing thread, a terminated thread, and no --db (O15, F02)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const made = yield* spindleWith(gate, ["run", "assistant", "-m", "setup", "--dir", queue, "--db", db])
        expect(yield* made.exit).toBe(0)
        const thread = yield* threadOf(made)
        const refused = (args: ReadonlyArray<string>) =>
          Effect.gen(function* () {
            const session = yield* chat(gate, ["assistant", "--dir", queue, ...args])
            yield* session.end
            return [yield* session.exit, session.out(), linesOf(session.err())]
          })
        expect(yield* refused(["--thread", "absent", "--db", db])).toEqual([1, "", [note.noThread("absent", db)]])
        expect(yield* refused(["--thread", thread])).toEqual([1, "", [note.threadNeedsDb]])
        const terminate = yield* spawn(gate, probe, ["terminate", "--thread", thread, ...project, "--db", db])
        expect(yield* terminate.exit).toBe(0)
        const before = yield* stored(db, thread)
        expect(before.terminated).not.toBeNull()
        expect(yield* refused(["--thread", thread, "--db", db])).toEqual([1, "", [note.terminated(thread)]])
        expect(yield* stored(db, thread)).toEqual(before)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "--thread refuses a thread of another agent and changes nothing (O15, F02)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const reply = `${stepLoop}/scripts/text-reply.json`
        const made = yield* spindleWith(gate, [
          "run",
          "quiet",
          "-m",
          "hi",
          "--dir",
          stepLoop,
          "--script",
          `${stepLoop}/scripts/no-tools.json`,
          "--db",
          db,
        ])
        expect(yield* made.exit).toBe(0)
        const thread = yield* threadOf(made)
        yield* query(
          db,
          "UPDATE threads SET run_state = 'running', run_reason = NULL, holder_id = 'lost', flow_id = 'old' WHERE id = ?",
          [thread],
        )
        yield* query(
          db,
          "CREATE TRIGGER no_recovery BEFORE UPDATE OF flow_id ON threads BEGIN SELECT RAISE(ABORT, 'recovery refused'); END",
        )
        const before = yield* stored(db, thread)
        const session = yield* chat(gate, [
          "assistant",
          "--thread",
          thread,
          "--dir",
          stepLoop,
          "--script",
          reply,
          "--db",
          db,
        ])
        yield* session.type("hello\n")
        yield* session.end
        expect(yield* session.exit).toBe(1)
        expect(session.out()).toBe("")
        expect(linesOf(session.err())).toEqual([note.otherAgent(thread, "quiet", "assistant")])
        expect(yield* stored(db, thread)).toEqual(before)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "with no --db the thread line says the thread lives in memory, and no resume line prints (O1, question 1)",
    () =>
      Effect.gen(function* () {
        const { gate } = yield* setup
        const session = yield* chat(gate, ["assistant", "--dir", queue])
        yield* session.type("one\n")
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual(["> one", "ack: one", "> "])
        expect(linesOf(session.err())).toEqual([note.thread(yield* threadOf(session)), note.memory])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "an empty line and a line of spaces send nothing (F06)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
        yield* session.type("\n   \none\n")
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual(["> ", ">    ", "> one", "ack: one", "> "])
        expect(yield* messagesOf(db, yield* threadOf(session))).toEqual([
          ["user", "one"],
          ["assistant", "ack: one"],
        ])
        expect(yield* requesters(gate)).toHaveLength(1)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live("preserves leading and trailing whitespace in a nonblank line", () =>
    Effect.gen(function* () {
      const { gate, db } = yield* setup
      const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
      const text = "  padded\t "
      yield* session.type(`${text}\n`)
      yield* session.end
      expect(yield* session.exit).toBe(0)
      expect((yield* messagesOf(db, yield* threadOf(session)))[0]).toEqual(["user", text])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.live(
    "a 200,000 character line and a line with control characters are stored as typed and printed escaped (O3, F07)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const long = "x".repeat(200_000)
        const odd = "a\u001b[31mb\u0007c\td"
        const session = yield* chat(gate, ["assistant", "--dir", queue, "--db", db])
        yield* session.type(`${long}\n${odd}\n`)
        yield* session.end
        expect(yield* session.exit).toBe(0)
        const thread = yield* threadOf(session)
        const rows = yield* query(db, "SELECT role, content FROM messages WHERE thread_id = ? ORDER BY seq", [thread])
        expect(rows.map((row) => [row.role, String(row.content).length])).toEqual([
          ["user", 200_000],
          ["assistant", 200_005],
          ["user", odd.length],
          ["assistant", odd.length + 5],
        ])
        expect(rows[0]?.content === long).toBe(true)
        expect([rows[2]?.content, rows[3]?.content]).toEqual([odd, `ack: ${odd}`])
        // biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for the raw control bytes
        expect(session.out()).not.toMatch(/[\u001b\u0007]/)
        expect(linesOf(session.out()).slice(2)).toEqual(["> a\\x1b[31mb\\x07c\td", "ack: a\\x1b[31mb\\x07c\td", "> "])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a secret prints as [redacted] in a typed line, a reply, call arguments, and a provider error, and the stored text keeps it (F12)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const token = "tok-chat-7Q2x9"
        const key = "sk-chat-1122334455"
        const script = at("leak.json")
        yield* write(
          script,
          JSON.stringify({
            responses: [
              { text: `the token is ${token}`, toolCalls: [{ name: "reveal", arguments: { note: token } }] },
              { text: `again ${token}` },
              { error: { message: `bad ${token}`, code: "auth_error", statusCode: 401 } },
            ],
          }),
        )
        const session = yield* chat(gate, ["leaky", "--dir", stepLoop, "--script", script, "--db", db], {
          env: { SHORT_TOKEN: token, SPINDLE_TEST_API_KEY: key },
        })
        yield* session.type(`my token is ${token}\nmore\n`)
        yield* session.end
        expect(yield* session.exit).toBe(0)
        const thread = yield* threadOf(session)
        expect(linesOf(session.out())).toEqual([
          "> my token is [redacted]",
          "the token is [redacted]",
          '[tool call] reveal {"note":"[redacted]"}',
          "[tool result] reveal ok: key [redacted] token [redacted]",
          "again [redacted]",
          "> more",
          "> ",
        ])
        expect(linesOf(session.err())).toEqual([
          note.thread(thread),
          note.providerError("bad [redacted]"),
          note.status("failed", "step_error"),
          note.resume("leaky", thread, db, stepLoop),
        ])
        for (const text of [session.out(), session.err()])
          for (const secret of [token, key]) expect(text).not.toContain(secret)
        expect(yield* messagesOf(db, thread)).toEqual([
          ["user", `my token is ${token}`],
          ["assistant", `the token is ${token}`],
          ["tool", "success"],
          ["assistant", `again ${token}`],
          ["user", "more"],
        ])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a silent message never prints, and a human-side message the chat did not send prints as elsewhere (O4, O7)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const script = `${hooks}/scripts/text-reply.json`
        const session = yield* chat(gate, ["visibility", "--dir", hooks, "--script", script, "--db", db])
        yield* session.type("hi\n")
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual(["[elsewhere] visible note", "> hi", "Hello! How can I help?", "> "])
        expect(yield* messagesOf(db, yield* threadOf(session))).toEqual([
          ["user", "visible note"],
          ["user", "silent note"],
          ["user", "hi"],
          ["assistant", "Hello! How can I help?"],
        ])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "an agent whose prompt is side B prints the reply and stores the line in the human side's role (O4)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const script = `${stepLoop}/scripts/text-reply.json`
        const session = yield* chat(gate, ["reversed", "--dir", stepLoop, "--script", script, "--db", db])
        yield* session.type("hi\n")
        yield* session.end
        expect(yield* session.exit).toBe(0)
        expect(linesOf(session.out())).toEqual(["> hi", "Hello! How can I help?", "> "])
        expect(yield* messagesOf(db, yield* threadOf(session))).toEqual([
          ["assistant", "hi"],
          ["user", "Hello! How can I help?"],
        ])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a provider error prints the provider line and the failed line, and the next line gets a reply (O10, F21)",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        const script = at("refuse-then-reply.json")
        yield* write(
          script,
          JSON.stringify({
            responses: [
              { error: { message: "The endpoint answered 401: bad key", code: "auth_error", statusCode: 401 } },
              { text: "back" },
            ],
          }),
        )
        const session = yield* chat(gate, ["assistant", "--dir", stepLoop, "--script", script, "--db", db])
        yield* session.type("one\ntwo\n")
        yield* session.end
        expect(yield* session.exit).toBe(0)
        const thread = yield* threadOf(session)
        expect(linesOf(session.out())).toEqual(["> one", "> two", "back", "> "])
        expect(linesOf(session.err())).toEqual([
          note.thread(thread),
          note.providerError("The endpoint answered 401: bad key"),
          note.status("failed", "step_error"),
          note.resume("assistant", thread, db, stepLoop),
        ])
        expect(yield* messagesOf(db, thread)).toEqual([
          ["user", "one"],
          ["user", "two"],
          ["assistant", "back"],
        ])
        expect(yield* statusOf(db, thread)).toEqual(["idle", "stop_on_response"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a provider that refuses connections leaves a thread that a resumed chat continues (lane 8, O2, O10, F21)",
    () =>
      Effect.gen(function* () {
        const { gate, db } = yield* setup
        const down = yield* chat(gate, ["assistant", "--dir", stepLoop, "--db", db], {
          env: { SPINDLE_TEST_BASE_URL: "http://127.0.0.1:1/v1" },
        })
        yield* down.type("one\n")
        yield* down.end
        expect(yield* down.exit).toBe(0)
        const thread = yield* threadOf(down)
        expect(linesOf(down.out())).toEqual(["> one", "> "])
        expect(linesOf(down.err())).toEqual([
          note.thread(thread),
          expect.stringMatching(/^spindle: provider error: ./),
          note.status("failed", "step_error"),
          note.resume("assistant", thread, db, stepLoop),
        ])
        expect(yield* messagesOf(db, thread)).toEqual([["user", "one"]])
        const script = `${stepLoop}/scripts/text-reply.json`
        const up = yield* chat(gate, [
          "assistant",
          "--thread",
          thread,
          "--dir",
          stepLoop,
          "--script",
          script,
          "--db",
          db,
        ])
        yield* up.type("two\n")
        yield* up.end
        expect(yield* up.exit).toBe(0)
        expect(linesOf(up.err()).slice(0, 2)).toEqual([note.thread(thread), note.status("failed", "step_error")])
        expect(linesOf(up.out())).toEqual(["> two", "Hello! How can I help?", "> "])
        expect(yield* statusOf(db, thread)).toEqual(["idle", "stop_on_response"])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )
})
