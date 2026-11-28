import { describe, expect, it } from "@effect/vitest"
import { Clock, ConfigProvider, Console, Effect, Exit, Fiber, FileSystem, Layer, Path, Queue } from "effect"
import { Command } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { Interrupts, PlatformLive, SqliteLive } from "#platform"
import { gate } from "../../../conformance/src/scenarios/harness.ts"
import { spindle } from "../../src/cli/main.ts"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { layer as sqliteStore } from "../../src/store/sqlite.ts"

const invoke = (
  subcommand: "run" | "send",
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
  fixture = "step-loop",
  interrupts?: Parameters<typeof Interrupts.of>[0],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const project = yield* path.fromFileUrl(new URL(`../../../conformance/fixtures/${fixture}`, import.meta.url))
    const out: Array<string> = []
    const err: Array<string> = []
    const capture = {
      ...globalThis.console,
      log: (...parts: ReadonlyArray<unknown>) => out.push(parts.join(" ")),
      error: (...parts: ReadonlyArray<unknown>) => err.push(parts.join(" ")),
    }
    const argv = args.map((arg) => (arg.startsWith("@") ? path.join(project, "scripts", arg.slice(1)) : arg))
    const command = Command.runWith(spindle, { version: "test" })([subcommand, "--dir", project, ...argv]).pipe(
      Effect.provideService(Console.Console, capture),
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))),
    )
    const exit = yield* (interrupts ? command.pipe(Effect.provideService(Interrupts, interrupts)) : command).pipe(
      Effect.exit,
    )
    return { exit, out, err }
  }).pipe(Effect.provide(PlatformLive))

const run = (args: ReadonlyArray<string>, env: Record<string, string> = {}, fixture = "step-loop") =>
  invoke("run", args, env, fixture)

const storedMessages = (filename: string, err: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const threadId = err.join("\n").match(/thread ([0-9a-f-]{36})/)?.[1] ?? ""
    const store = yield* MessageStore
    return (yield* store.getMessages(threadId, { order: "asc", includeSilent: true })).messages
  }).pipe(Effect.provide(Layer.provide(sqliteStore, SqliteLive({ filename }))))

describe("spindle run", () => {
  it.effect("prints the assistant text of a scripted reply and exits 0", () =>
    Effect.gen(function* () {
      const { exit, out, err } = yield* run(["assistant", "-m", "hello", "--script", "@text-reply.json"])
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(out).toEqual(["Hello! How can I help?"])
      expect(err[0]).toMatch(/^spindle: idle \(stop_on_response\) after 1 step, thread /)
    }),
  )

  it.effect("prints the seven phases of a step in order with --trace", () =>
    Effect.gen(function* () {
      const { out } = yield* run(["assistant", "-m", "hello", "--script", "@text-reply.json", "--trace"])
      const lines = out.filter((line) => line.startsWith("step 1 ")).map((line) => line.split(/[\s,]+/))
      const phases = lines.map((words) => words[2]).filter((phase, index, all) => phase !== all[index - 1])
      expect(phases).toEqual(["drain", "assemble", "call", "persist-response", "tools", "persist-results", "stop"])
      expect(lines.filter((words) => words[2] === "assemble").map((words) => words[3])).toEqual([
        "interpolate",
        "after_system_message",
        "snapshot",
        "filter_messages",
        "transform",
        "prefilter_llm_history",
        "dispatch",
      ])
    }),
  )

  it.effect("runs a hook from an installed package only for the agent whose list names it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-run-" })
      const stamps = (agent: string, db: string) =>
        Effect.gen(function* () {
          const { exit, err } = yield* run([agent, "-m", "hi", "--script", "@text-reply.json", "--db", db], {}, "hooks")
          expect(Exit.isSuccess(exit)).toBe(true)
          return (yield* storedMessages(db, err)).map((message) => [message.role, message.metadata?.loud ?? null])
        })
      expect(yield* stamps("plain", path.join(dir, "plain.db"))).toEqual([
        ["user", null],
        ["assistant", null],
      ])
      expect(yield* stamps("standardagent-loud/loud", path.join(dir, "loud.db"))).toEqual([
        ["user", true],
        ["assistant", true],
      ])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.live("goes on after --hook-timeout and prints the hook's id on standard error without the message", () =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis
      const { exit, out, err } = yield* run(
        ["stuck", "-m", "private words", "--script", "@text-reply.json", "--hook-timeout", "0.2"],
        {},
        "hooks",
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(5000)
      expect(out).toEqual(["Hello! How can I help?"])
      expect(err[0]).toBe(
        "spindle: Hook never_settles (filter_messages, once per context assembly, on the history snapshot) did not settle within 200ms. Spindle kept the history the hook was given. Its ThreadState refuses every later call, and Spindle cannot undo what it does after this point by other means.",
      )
      expect(err.join("\n")).not.toContain("private words")
      const zero = yield* run(["stuck", "-m", "hi", "--script", "@text-reply.json", "--hook-timeout", "0"], {}, "hooks")
      expect(Exit.isFailure(zero.exit)).toBe(true)
      expect(zero.err).toEqual(["spindle: --hook-timeout takes a number of seconds above 0"])
    }),
  )

  it.effect("stores the user message and the reply in the database that --db names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-run-" }), "run.db")
      const { exit, err } = yield* run(["assistant", "-m", "save blue", "--script", "@two-tools.json", "--db", db])
      expect(Exit.isSuccess(exit)).toBe(true)
      const messages = yield* storedMessages(db, err)
      expect(messages.map((m) => [m.role, m.role === "tool" ? m.tool_call_id : m.content])).toEqual([
        ["user", "save blue"],
        ["assistant", "I will save the note and read it back."],
        ["tool", "call_1"],
        ["tool", "call_2"],
        ["assistant", "The note says the color is blue."],
      ])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("names the path and the cause when the --db file cannot be opened", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-run-" })
      const notDb = path.join(dir, "notes.txt")
      yield* fs.writeFileString(notDb, "this is not a SQLite database, it is a plain text file of some length")
      const missing = path.join(dir, "no", "such", "x.db")
      const errors: Array<string | undefined> = []
      for (const db of [missing, dir, notDb]) {
        const { exit, err } = yield* run(["assistant", "-m", "hi", "--script", "@text-reply.json", "--db", db])
        expect(Exit.isFailure(exit)).toBe(true)
        errors.push(err.at(-1))
      }
      expect(errors).toEqual([
        `spindle: cannot open the database ${missing}: the directory ${path.dirname(missing)} does not exist`,
        `spindle: cannot open the database ${dir}: it is a directory`,
        `spindle: cannot open the database ${notDb}: file is not a database`,
      ])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("learns the secret set before it prints a setup error about the database or the script", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-run-" })
      const token = "SETUP-TOKEN-58"
      const db = path.join(dir, token, "x.db")
      const missingDb = yield* run(["leaky", "-m", "hi", "--script", "@reveal.json", "--db", db], {
        SHORT_TOKEN: token,
      })
      const script = path.join(dir, `${token}.json`)
      const missingScript = yield* run(["leaky", "-m", "hi", "--script", script], { SHORT_TOKEN: token })
      expect([missingDb.err, missingScript.err]).toEqual([
        [
          `spindle: cannot open the database ${path.join(dir, "[redacted]", "x.db")}: the directory ${path.join(dir, "[redacted]")} does not exist`,
        ],
        [expect.stringMatching(/^spindle: cannot read the script .*\[redacted\]\.json/)],
      ])
      for (const result of [missingDb, missingScript])
        expect([...result.out, ...result.err].join("\n")).not.toContain(token)
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("stops on a stop tool that the agent names with its package prefix", () =>
    Effect.gen(function* () {
      const { exit, out, err } = yield* run(
        ["standardagent-closer/closer", "-m", "go", "--script", "@stop.json", "--trace"],
        {},
        "packed-stop-tool",
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(out.filter((line) => line.startsWith("step 1 stop") || line.startsWith("step 2"))).toEqual([
        "step 1 stop             stop_tool",
      ])
      expect(err).toEqual([expect.stringMatching(/^spindle: idle \(stop_tool\) after 1 step, thread /)])
    }),
  )

  it.effect("prints each request as JSON with --dump-requests, with no abort signal and every secret redacted", () =>
    Effect.gen(function* () {
      const { out } = yield* run(["quiet", "-m", "hi", "--script", "@no-tools.json", "--dump-requests"])
      const request = JSON.parse(out.slice(0, -1).join("\n"))
      expect(request).toMatchObject({ model: "claude-haiku-5-5", toolChoice: "none" })
      expect(request.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
        "write_note",
        "read_note",
      ])
      expect(request).not.toHaveProperty("signal")
    }),
  )

  it.effect("reports a missing provider variable, an unknown agent, and a bad script as one plain line each", () =>
    Effect.gen(function* () {
      const missing = yield* run(["assistant", "-m", "hi"])
      expect(Exit.isFailure(missing.exit)).toBe(true)
      expect(missing.err.at(-1)).toBe(
        "spindle: The provider of model lane needs SPINDLE_TEST_BASE_URL, which has no value",
      )
      const unknown = yield* run(["nobody", "-m", "hi", "--script", "@text-reply.json"])
      expect(unknown.err).toEqual(["spindle: No agent named nobody is defined"])
      const script = yield* run(["assistant", "-m", "hi", "--script", "@missing.json"])
      expect(script.err).toHaveLength(1)
      expect(script.err[0]).toMatch(/^spindle: cannot read the script .*missing\.json/)
      for (const result of [missing, unknown, script]) expect(result.err.join("\n")).not.toMatch(/\n\s+at /)
    }),
  )

  it.effect("sends the API key slot to the endpoint and prints no line that holds it", () =>
    Effect.gen(function* () {
      const key = "sk-test-0123456789"
      const seen: Array<string | null> = []
      const events = [
        [
          { delta: { content: `echo ${key}` } },
          {
            delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read_note", arguments: '{"key":"k"}' } }] },
          },
          { delta: {}, finish_reason: "tool_calls" },
        ],
        [{ delta: { content: "done" }, finish_reason: "stop" }],
      ]
      const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get("authorization"))
        const choices = events[seen.length - 1] ?? []
        const body = choices.map((choice) => `data: ${JSON.stringify({ choices: [choice] })}\n\n`).join("")
        return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
      }
      const fake = Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)
      const { exit, out, err } = yield* run(["assistant", "-m", "hi", "--dump-requests", "--trace"], {
        SPINDLE_TEST_BASE_URL: "http://endpoint.test/v1",
        SPINDLE_TEST_API_KEY: key,
      }).pipe(Effect.provide(fake))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(seen).toEqual([`Bearer ${key}`, `Bearer ${key}`])
      expect(out).toContain("echo [redacted]")
      const dumps = out.join("\n").match(/^\{$[\s\S]*?^\}$/gm) ?? []
      expect(dumps).toHaveLength(2)
      expect(JSON.parse(dumps[1] ?? "{}").messages[2]).toMatchObject({ role: "assistant", content: "echo [redacted]" })
      expect([...out, ...err].join("\n")).not.toContain(key)
    }),
  )

  it.effect("redacts a secret learned only by a thread creation hook", () =>
    Effect.gen(function* () {
      const { exit, out, err } = yield* run(
        ["creation_secret", "-m", "hi", "--script", "@text-reply.json"],
        { SPINDLE_CREATION_SECRET: "Hello!" },
        "hooks",
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(out).toEqual(["[redacted] How can I help?"])
      expect(err.join("\n")).not.toContain("Hello!")
    }),
  )

  it.effect("redacts the endpoint key and a three-character token from every printed line and the database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-run-" }), "run.db")
      const secrets = { SPINDLE_TEST_API_KEY: "sk-test-9876543210", SHORT_TOKEN: "Q7z" }
      const { exit, out, err } = yield* run(
        ["leaky", "-m", "hi", "--script", "@reveal.json", "--trace", "--dump-requests", "--db", db],
        secrets,
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(out).toContain("[tool result] reveal success: key [redacted] token [redacted]")
      const rows = yield* storedMessages(db, err)
      expect(rows.map((m) => [m.role, m.name, m.tool_status, m.content])).toEqual([
        ["user", null, null, "hi"],
        ["assistant", null, null, null],
        ["tool", "reveal", "success", "key [redacted] token [redacted]"],
        ["assistant", null, null, "done"],
      ])
      const files = (yield* fs.readDirectory(path.dirname(db))).map((name) => path.join(path.dirname(db), name))
      const stored = (yield* Effect.forEach(files, (file) => fs.readFile(file), { concurrency: 1 })).map((bytes) =>
        new TextDecoder().decode(bytes),
      )
      for (const secret of Object.values(secrets))
        for (const text of [...out, ...err, ...stored, JSON.stringify(rows)]) expect(text).not.toContain(secret)
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("redacts the instance value of a declared variable whose definition gives it a public default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-run-" }), "run.db")
      const hint = "inst-hint-4821"
      const { exit, out, err } = yield* run(
        ["shaded", "-m", "hi", "--script", "@recite.json", "--trace", "--dump-requests", "--db", db],
        { REGION_HINT: hint },
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      const dumps = out.join("\n").match(/^\{$[\s\S]*?^\}$/gm) ?? []
      expect(JSON.parse(dumps[0] ?? "{}").messages[0]).toEqual({ role: "system", content: "Region: public-region" })
      expect(out).toContain("[tool result] recite success: hint [redacted]")
      const rows = yield* storedMessages(db, err)
      expect(rows.filter((m) => m.role === "tool").map((m) => [m.tool_status, m.content])).toEqual([
        ["success", "hint [redacted]"],
      ])
      expect([...out, ...err, JSON.stringify(rows)].join("\n")).not.toContain(hint)
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("redacts a three-character common word from every line it prints, the summary line included", () =>
    Effect.gen(function* () {
      const secrets = { SPINDLE_TEST_API_KEY: "sk-test-1357913579", SHORT_TOKEN: "top" }
      const { exit, out, err } = yield* run(
        ["leaky", "-m", "hi", "--script", "@reveal.json", "--trace", "--dump-requests"],
        secrets,
      )
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(err).toEqual([
        expect.stringMatching(/^spindle: idle \(s\[redacted\]_on_response\) after 2 steps, thread /),
      ])
      expect(out).toContain("[tool result] reveal success: key [redacted] token [redacted]")
      for (const line of [...out, ...err])
        for (const secret of Object.values(secrets)) expect(line).not.toContain(secret)
    }),
  )

  it.effect("fails before any request when a prompt declares the endpoint key as a text variable", () =>
    Effect.gen(function* () {
      const key = "sk-test-2468024680"
      const { exit, out, err } = yield* run(["keyed", "-m", "hi", "--script", "@text-reply.json", "--dump-requests"], {
        SPINDLE_TEST_API_KEY: key,
      })
      expect(Exit.isFailure(exit)).toBe(true)
      expect(out).toEqual([])
      expect(err.at(-1)).toBe(
        "spindle: Prompt keyed interpolates variable SPINDLE_TEST_API_KEY, which a declaration or the provider config marks secret. A system prompt never holds a secret.",
      )
      expect(err.join("\n")).not.toContain(key)
    }),
  )

  it.live("stores nothing from a stream cut off before its finish and runs none of its tool calls", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-run-" }), "run.db")
      const answers = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Saving.", tool_calls: [{ index: 0, id: "c1", function: { name: "write_note", arguments: '{"key":"k","value":"v"}' } }] } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      ]
      const fetch = async (_input: string | URL | Request, _init?: RequestInit) => new Response(answers.shift() ?? "")
      const { exit, err } = yield* run(["assistant", "-m", "save", "--db", db], {
        SPINDLE_TEST_BASE_URL: "http://endpoint.test/v1",
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch))
      expect(Exit.isSuccess(exit)).toBe(true)
      const messages = yield* storedMessages(db, err)
      expect(messages.map((m) => [m.role, m.content, m.tool_calls])).toEqual([
        ["user", "save", null],
        ["assistant", "Done.", null],
      ])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.live("retries a response whose body the transport times out after the headers arrived", () =>
    Effect.gen(function* () {
      let sends = 0
      const fetch = async (_input: string | URL | Request, _init?: RequestInit) => {
        sends += 1
        if (sends === 1)
          return new Response(
            new ReadableStream({
              start: (controller) => controller.error(new DOMException("transport deadline", "TimeoutError")),
            }),
          )
        const done = { choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }
        return new Response(`data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`)
      }
      const { exit, out, err } = yield* run(["assistant", "-m", "hi", "--trace"], {
        SPINDLE_TEST_BASE_URL: "http://endpoint.test/v1",
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(sends).toBe(2)
      expect(out.filter((line) => line.startsWith("step 1 call "))).toEqual([
        "step 1 call             spindle_test claude-haiku-5-5 attempt 1",
        "step 1 call             spindle_test claude-haiku-5-5 attempt 2",
      ])
      expect(err).toEqual([expect.stringMatching(/^spindle: idle \(stop_on_response\) after 1 step, thread /)])
    }),
  )

  it.effect("sends the reasoning text and details of an earlier response back through openaiCompatible", () =>
    Effect.gen(function* () {
      const details = [
        { type: "reasoning.text", text: "save first", signature: "sig-7", format: "anthropic-claude-v1" },
      ]
      const bodies: Array<{ messages: Array<Record<string, unknown>> }> = []
      const answers = [
        {
          delta: {
            content: "Saving.",
            reasoning_content: "I should save.",
            reasoning_details: details,
            tool_calls: [
              { index: 0, id: "c1", function: { name: "write_note", arguments: '{"key":"k","value":"v"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
        { delta: { content: "Saved." }, finish_reason: "stop" },
      ]
      const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        const choice = answers[bodies.length - 1]
        return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`)
      }
      const { exit } = yield* run(["assistant", "-m", "save"], {
        SPINDLE_TEST_BASE_URL: "http://endpoint.test/v1",
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch))
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(bodies[1]?.messages[2]).toMatchObject({
        role: "assistant",
        content: "Saving.",
        reasoning_content: "I should save.",
        reasoning_details: details,
      })
    }),
  )

  it.effect("prints an HTTP 401 diagnostic without the key that the endpoint echoed", () =>
    Effect.gen(function* () {
      const key = "sk-test-5555555555"
      const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization")
        return Response.json({ error: { message: `Rejected ${auth} and fixture-default-key` } }, { status: 401 })
      }
      const { exit, out, err } = yield* run(["assistant", "-m", "hi"], {
        SPINDLE_TEST_BASE_URL: "http://endpoint.test/v1",
        SPINDLE_TEST_API_KEY: key,
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(err.at(-1)).toBe("spindle: The endpoint answered 401: Rejected Bearer [redacted] and [redacted]")
      expect([...out, ...err].join("\n")).not.toContain(key)
    }),
  )

  it.effect(
    "rules 9, 10, 12: keeps session_turns durable across spindle run and spindle send and resets for a new session",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const db = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-sides-" }), "sides.db")
        const first = yield* run(["capped", "-m", "m1", "--script", "@reply.json", "--db", db], {}, "sides")
        expect(Exit.isSuccess(first.exit)).toBe(true)
        expect(first.err.at(-1)).toMatch(/^spindle: idle \(stop_on_response\) after 1 step, thread /)
        const threadId = first.err.join("\n").match(/thread ([0-9a-f-]{36})/)?.[1] ?? ""
        const second = yield* invoke("send", [threadId, "-m", "m2", "--script", "@reply.json", "--db", db], {}, "sides")
        expect(Exit.isSuccess(second.exit)).toBe(true)
        expect(second.err.at(-1)).toMatch(/^spindle: idle \(max_session_turns\) after 1 step, thread /)
        const third = yield* invoke("send", [threadId, "-m", "m3", "--script", "@reply.json", "--db", db], {}, "sides")
        expect(Exit.isSuccess(third.exit)).toBe(true)
        expect(third.err.at(-1)).toMatch(/^spindle: idle \(stop_on_response\) after 1 step, thread /)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("rules 1, 10, 32: runs a prompt x prompt agent through spindle run until max_session_turns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-sides-" }), "pair.db")
      const result = yield* run(["pair", "-m", "start", "--script", "@pair.json", "--db", db], {}, "sides")
      expect(Exit.isSuccess(result.exit)).toBe(true)
      expect(result.err.at(-1)).toMatch(/^spindle: idle \(max_session_turns\) after 2 steps, thread /)
      const messages = yield* storedMessages(db, result.err)
      expect(messages.map((m) => [m.role, m.content, m.prompt])).toEqual([
        ["user", "start", null],
        ["assistant", "from A", "worker"],
        ["user", "from B", "reviewer"],
      ])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.live("prints the still-queued notice when spindle send exits 0 after the active run stops without draining", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const db = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-sides-" }), "queued.db")
      const first = yield* run(["capped", "-m", "m1", "--script", "@reply.json", "--db", db], {}, "sides")
      expect(Exit.isSuccess(first.exit)).toBe(true)
      const threadId = first.err.join("\n").match(/thread ([0-9a-f-]{36})/)?.[1] ?? ""

      const entered = gate()
      const release = gate()
      const signals = yield* Queue.unbounded<void>()
      const interrupts = Interrupts.of({ listen: Effect.succeed(signals) })
      const fetch = async (_input: string | URL | Request, _init?: RequestInit) => {
        entered.release()
        await release.opened
        const choice = { delta: { content: "turn two" }, finish_reason: "stop" }
        return new Response(`data: ${JSON.stringify({ choices: [choice] })}\n\ndata: [DONE]\n\n`)
      }

      const second = yield* Effect.forkChild(
        invoke(
          "send",
          [threadId, "-m", "m2", "--db", db],
          { SPINDLE_TEST_BASE_URL: "http://endpoint.test/v1" },
          "sides",
          interrupts,
        ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch)),
      )
      yield* Effect.promise(() => entered.opened)

      const third = yield* Effect.forkChild(
        invoke("send", [threadId, "-m", "m3", "--script", "@reply.json", "--db", db], {}, "sides"),
      )

      const checkQueue = RunStore.use((store) => store.queueLength(threadId)).pipe(
        Effect.provide(Layer.provide(sqliteStore, SqliteLive({ filename: db }))),
      )
      while ((yield* checkQueue) === 0) yield* Effect.sleep("20 millis")

      yield* Queue.offer(signals, undefined)
      yield* Effect.sleep("20 millis")
      release.release()
      const secondResult = yield* Fiber.join(second)
      const thirdResult = yield* Fiber.join(third)

      expect(Exit.isSuccess(secondResult.exit)).toBe(true)
      expect(secondResult.err.at(-1)).toMatch(/^spindle: idle \(aborted_by_user\) after 1 step, thread /)
      expect(Exit.isSuccess(thirdResult.exit)).toBe(true)
      expect(thirdResult.err).toContain(`spindle: idle (aborted_by_user), thread ${threadId}`)
      expect(thirdResult.err).toContain(
        "spindle: Your message is still queued and the next run of this thread will deliver it.",
      )
      expect(yield* checkQueue).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("rules 19, 22, 26, decision 5: runs handler x human and handler x handler agents through spindle run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-handlers-" })
      const relayDb = path.join(dir, "relay.db")
      const okRun = yield* run(["relay", "-m", "reply", "--db", relayDb], {}, "handlers-crash")
      expect(Exit.isSuccess(okRun.exit), okRun.err.join(" | ")).toBe(true)
      expect(okRun.out).toEqual(["handler-replied"])
      expect(okRun.err.at(-1)).toMatch(/^spindle: idle \(handler_idle\) after 0 steps, thread /)

      const failRun = yield* run(["relay", "-m", "throw", "--db", path.join(dir, "fail.db")], {}, "handlers-crash")
      expect(Exit.isFailure(failRun.exit)).toBe(true)
      expect(failRun.err.some((line) => /^spindle: failed \(handler_error\) after 0 steps, thread /.test(line))).toBe(
        true,
      )

      const pairDb = path.join(dir, "pair.db")
      const pairRun = yield* run(["ping_pong", "-m", "go", "--db", pairDb], {}, "handlers-crash")
      expect(Exit.isSuccess(pairRun.exit)).toBe(true)
      expect(pairRun.err.at(-1)).toMatch(/^spindle: idle \(max_session_turns\) after 0 steps, thread /)
      const stored = yield* storedMessages(pairDb, pairRun.err)
      expect(stored.map((m) => [m.role, m.content])).toEqual([
        ["user", "go"],
        ["assistant", "a:go"],
        ["user", "b:a:go"],
        ["assistant", "a:b:a:go"],
      ])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )
})
