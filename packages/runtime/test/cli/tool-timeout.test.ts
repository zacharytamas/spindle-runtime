import { expect, it } from "@effect/vitest"
import { Effect, FileSystem } from "effect"
import { PlatformLive } from "#platform"
import { project, setup, spindle, threadIn } from "./processes.ts"

it.live(
  "run, send and chat reject invalid tool limits before starting with one diagnostic and exit 1",
  () =>
    Effect.gen(function* () {
      const { gate, db, at } = yield* setup
      const fs = yield* FileSystem.FileSystem
      const script = at("reply.json")
      yield* fs.writeFileString(script, JSON.stringify({ responses: [{ text: "ready" }] }))
      const flags = [...project, "--db", db, "--script", script]
      const seed = yield* spindle(gate, ["run", "assistant", "-m", "go", ...flags])
      expect(yield* seed.exit).toBe(0)
      const thread = yield* threadIn(seed)
      const cases = [
        { cmd: ["run", "assistant", "-m", "go"], limits: ["0"], issue: /above 0/ },
        { cmd: ["send", thread, "-m", "go"], limits: ["hold=-1"], issue: /above 0/ },
        { cmd: ["chat", "assistant"], limits: ["bogus=1"], issue: /no tool.*bogus/ },
        { cmd: ["run", "assistant", "-m", "go"], limits: ["hold=1", "hold=2"], issue: /hold.*twice/ },
        { cmd: ["run", "assistant", "-m", "go"], limits: ["=2"], issue: /NAME=SECONDS/ },
        { cmd: ["run", "assistant", "-m", "go"], limits: ["hold=1=2"], issue: /NAME=SECONDS/ },
        { cmd: ["run", "assistant", "-m", "go"], limits: ["NaN"], issue: /finite/ },
        { cmd: ["run", "assistant", "-m", "go"], limits: ["Infinity"], issue: /finite/ },
        { cmd: ["run", "assistant", "-m", "go"], limits: ["hold=-Infinity"], issue: /finite/ },
      ]
      for (const { cmd, limits, issue } of cases) {
        const child = yield* spindle(gate, [...cmd, ...flags, ...limits.flatMap((v) => ["--tool-timeout", v])])
        expect(yield* child.exit).toBe(1)
        expect(child.out).toEqual([])
        expect(child.err).toEqual([expect.stringMatching(/^spindle: --tool-timeout /)])
        expect(child.err[0]).toMatch(issue)
      }
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  60_000,
)

it.live(
  "spindle run exits normally with a never-returning tool and the named limit wins over the general one",
  () =>
    Effect.gen(function* () {
      const { gate, at } = yield* setup
      const script = at("hold.json")
      yield* (yield* FileSystem.FileSystem).writeFileString(
        script,
        JSON.stringify({
          responses: [{ toolCalls: [{ name: "hold", arguments: { name: "forever" } }] }, { text: "finished" }],
        }),
      )
      const child = yield* spindle(gate, [
        "run",
        "assistant",
        "-m",
        "go",
        ...project,
        "--tool-timeout",
        "hold=1",
        "--tool-timeout",
        "60",
        "--script",
        script,
      ])
      expect(yield* child.exit).toBe(0)
      expect(child.out).toEqual([
        '[tool call] hold {"name":"forever"}',
        "[tool result] hold error: Tool hold timed out after 1s",
        "finished",
      ])
      expect(child.err).toEqual([expect.stringMatching(/^spindle: idle \(stop_on_response\) after 2 steps, thread /)])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  10_000,
)
