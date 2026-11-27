import { describe, expect, it } from "@effect/vitest"
import { Console, Effect, Exit, FileSystem, Path } from "effect"
import { Command } from "effect/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { PlatformLive, platformName } from "#platform"
import { spindle } from "../../src/cli/main.ts"

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

const copyFixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const fixture = yield* path.fromFileUrl(new URL(`../../../conformance/fixtures/${name}`, import.meta.url))
    const root = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-cli-" }), "project")
    yield* fs.copy(fixture, root)
    return root
  })

const brokenManifest = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const fixture = yield* path.fromFileUrl(
    new URL("../../../conformance/fixtures/invalid/broken-manifest", import.meta.url),
  )
  const root = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-cli-" }), "project")
  yield* fs.copy(fixture, root)
  yield* fs.makeDirectory(path.join(root, "agents", "packed", "sample"), { recursive: true })
  yield* fs.writeFileString(path.join(root, "agents", "packed", "sample", "package.json"), "{")
  return root
})

const multilineLoader = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-cli-" }), "project")
  const dir = path.join(root, "agents", "packed", "standardagent-multiline")
  yield* fs.makeDirectory(dir, { recursive: true })
  yield* fs.writeFileString(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "standardagent-multiline", type: "module", keywords: ["standardagent"], standardagent: {} }),
  )
  yield* fs.writeFileString(
    path.join(dir, "index.js"),
    [
      "export const agents = {}",
      "export const handlers = {}",
      "export const prompts = {}",
      "export const models = {}",
      "export const hooks = {}",
      'export const tools = { multiline: async () => { throw new Error("first line\\nsecond line") } }',
      'export const __meta = { packageId: "standardagent-multiline", version: "1.0.0", entryAgents: [], packedAt: 0 }',
    ].join("\n"),
  )
  return root
})

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
      expect(lines.at(-1)).toBe("0 errors, 4 warnings")
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

  it.effect("prints JSON for every issue when a package manifest is not JSON", () =>
    Effect.gen(function* () {
      const { exit, lines } = yield* run("--json", yield* brokenManifest)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.parse(lines.join("\n"))).toEqual([
        expect.objectContaining({ code: "agent_both_sides_human", file: "agents/agents/both_human.ts" }),
        expect.objectContaining({ code: "package_invalid", file: "agents/packed/sample/package.json" }),
      ])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("prints a multi-line issue message on one line and keeps its line break with --json", () =>
    Effect.gen(function* () {
      const root = yield* multilineLoader
      const message = "standardagent-multiline tools.multiline failed to load: first line\nsecond line"
      const text = yield* run(root)
      expect(Exit.isFailure(text.exit)).toBe(true)
      const physical = text.lines.join("\n").split("\n")
      expect(physical).toHaveLength(3)
      expect(physical[0]).toBe(
        "definition_load_failed error agents/packed/standardagent-multiline/index.js:tools.multiline standardagent-multiline tools.multiline failed to load: first line\\nsecond line",
      )
      expect(physical.at(-1)).toBe("1 error, 0 warnings")
      const json = yield* run("--json", root)
      expect(JSON.parse(json.lines.join("\n"))).toEqual([
        expect.objectContaining({ code: "definition_load_failed", message }),
      ])
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("reports an empty or export-free file as missing its export when the runtime itself imports it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const main = yield* path.fromFileUrl(new URL("../../src/cli/main.ts", import.meta.url))
      const root = yield* copyFixture("invalid/empty-files")
      const output = yield* spawner.string(
        ChildProcess.make(platformName, ["--conditions=spindle-source", main, "validate", "--json", root]),
      )
      expect(JSON.parse(output)).toEqual(
        ["comment_only", "emptyfile", "unexported"].map((name) =>
          expect.objectContaining({ code: "definition_export_missing", file: `agents/tools/${name}.ts` }),
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )

  it.effect("loads each package entry shape when the runtime itself imports it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const main = yield* path.fromFileUrl(new URL("../../src/cli/main.ts", import.meta.url))
      const root = yield* copyFixture("package-entries")
      const output = yield* spawner.string(
        ChildProcess.make(platformName, ["--conditions=spindle-source", main, "validate", "--json", "--list", root]),
      )
      const { definitions, issues } = JSON.parse(output)
      expect(issues).toEqual([])
      expect(definitions.map((d: { qualifiedName: string }) => d.qualifiedName)).toContain(
        "standardagent-main-directory/main_directory",
      )
      expect(definitions).toHaveLength(9)
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
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
