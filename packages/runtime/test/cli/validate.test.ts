import { describe, expect, it } from "@effect/vitest"
import { Console, Effect, Exit, Path } from "effect"
import { Command } from "effect/cli"
import { PlatformLive } from "#platform"
import { validateCommand } from "../../src/cli/validate.ts"

const spindle = Command.make("spindle").pipe(Command.withSubcommands([validateCommand]))

const run = (...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fixtures = yield* path.fromFileUrl(new URL("../../../conformance/fixtures/", import.meta.url))
    const lines: Array<string> = []
    const capture = { ...globalThis.console, log: (...parts: ReadonlyArray<unknown>) => lines.push(parts.join(" ")) }
    const argv = args.map((arg) => (arg.startsWith("@") ? path.join(fixtures, arg.slice(1)) : arg))
    const exit = yield* Command.runWith(spindle, { version: "test" })(["validate", ...argv]).pipe(
      Effect.provideService(Console.Console, capture),
      Effect.exit,
    )
    return { exit, lines }
  }).pipe(Effect.provide(PlatformLive))

describe("spindle validate", () => {
  it.effect("prints the count of each kind and exits 0 for a valid directory", () =>
    Effect.gen(function* () {
      const { exit, lines } = yield* run("@agents-basic")
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(lines).toEqual([
        "agents 3, prompts 3, tools 1, models 1, hooks 2, handlers 1, effects 1",
        "0 errors, 0 warnings",
      ])
    }),
  )

  it.effect("prints one line per issue as code, severity, path, and message, and exits 1", () =>
    Effect.gen(function* () {
      const { exit, lines } = yield* run("@invalid/both-sides-human")
      expect(Exit.isFailure(exit)).toBe(true)
      expect(lines[0]).toBe(
        "agent_both_sides_human error agents/agents/both_human.ts:sideB Both sides human is reserved in this version — runtimes reject it. Back at least one side with a prompt or handler.",
      )
      expect(lines.at(-1)).toBe("1 error, 0 warnings")
    }),
  )

  it.effect("exits 0 when every issue is a warning", () =>
    Effect.gen(function* () {
      const { exit, lines } = yield* run("@invalid/naming-warnings")
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(lines.at(-1)).toBe("0 errors, 2 warnings")
    }),
  )

  it.effect("prints the issues as a JSON list of code, severity, message, and path with --json", () =>
    Effect.gen(function* () {
      const { exit, lines } = yield* run("--json", "@invalid/three-errors")
      expect(Exit.isFailure(exit)).toBe(true)
      const issues: unknown = JSON.parse(lines.join("\n"))
      expect(issues).toEqual([
        expect.objectContaining({ code: "agent_both_sides_human", severity: "error", path: "sideB" }),
        expect.objectContaining({ code: "model_id_missing", severity: "error", path: "model" }),
        expect.objectContaining({ code: "prompt_tool_choice_invalid", severity: "error", path: "toolChoice" }),
      ])
      for (const issue of issues as Array<Record<string, unknown>>)
        expect(Object.keys(issue).sort()).toEqual(["code", "file", "message", "path", "severity"])
    }),
  )

  it.effect("lists every definition by kind, qualified name, package, and name with --list", () =>
    Effect.gen(function* () {
      const { exit, lines } = yield* run("--list", "@namespace-isolation")
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(lines.slice(0, 9)).toEqual([
        "KIND    QUALIFIED NAME       PACKAGE   NAME        VISIBILITY",
        "agent   packed-a/researcher  packed-a  researcher  entry",
        "agent   packed-b/writer      packed-b  writer      entry",
        "prompt  packed-a/researcher  packed-a  researcher  internal",
        "prompt  packed-b/writer      packed-b  writer      internal",
        "tool    packed-a/search      packed-a  search      internal",
        "tool    packed-b/search      packed-b  search      internal",
        "model   packed-a/fast        packed-a  fast        internal",
        "model   packed-b/fast        packed-b  fast        internal",
      ])
    }),
  )
})
