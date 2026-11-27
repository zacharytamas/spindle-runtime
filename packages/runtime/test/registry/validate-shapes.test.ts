import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { PlatformLive } from "#platform"
import type { Issue } from "../../src/registry/definition.ts"
import { Registry } from "../../src/registry/Registry.ts"
import { validate } from "../../src/registry/validate.ts"

// Page references are relative to content/0.2.0 of the spec. Type references are to
// node_modules/@standardagents/spec/dist/index.d.ts. Each fixture holds the faulty files and their legal neighbors, so
// an exact list of issues proves both that each fault is reported at its field and that no neighbor is.
// The tests leave the issue code to the build and pin the file, the field path, and the severity.

const fixture = (name: string) =>
  Path.Path.pipe(
    Effect.flatMap((path) => path.fromFileUrl(new URL(`../../../conformance/fixtures/${name}`, import.meta.url))),
  )

const validateRoot = (root: string) => validate.pipe(Effect.provide(Registry.layer(root)))

const validateFixture = (name: string) => fixture(name).pipe(Effect.flatMap(validateRoot))

const location = (issue: Issue) => (issue.path === "" ? issue.file : `${issue.file}:${issue.path}`)

const located = (issues: ReadonlyArray<Issue>) => issues.map((issue) => `${location(issue)} ${issue.severity}`).sort()

const error = (at: string) => `${at} error`

type Case = readonly [title: string, fixture: string, expected: ReadonlyArray<string>]

const shapes: ReadonlyArray<Case> = [
  [
    // prompts.md:26 types includeChat as boolean. Neighbors: includeChat true and false.
    "rejects an includeChat that is not a boolean and accepts true and false",
    "prompt-include-chat",
    [error("agents/prompts/chat_yes.ts:includeChat")],
  ],
  [
    // models.md:80-88 types each capability, and ModelCapabilities in index.d.ts:3788 agrees. Neighbors: every
    // capability with a legal value, reasoningLevels { 0: null }, and an empty capabilities object.
    "rejects a model capability of the wrong type and accepts every capability with a legal value",
    "model-capabilities",
    [
      error("agents/models/levels_string.ts:capabilities.reasoningLevels"),
      error("agents/models/levels_value.ts:capabilities.reasoningLevels.100"),
      error("agents/models/max_context_tokens.ts:capabilities.maxContextTokens"),
      error("agents/models/max_output_tokens.ts:capabilities.maxOutputTokens"),
      error("agents/models/supports_images.ts:capabilities.supportsImages"),
      error("agents/models/supports_json_mode.ts:capabilities.supportsJsonMode"),
      error("agents/models/supports_streaming.ts:capabilities.supportsStreaming"),
      error("agents/models/supports_tool_calls.ts:capabilities.supportsToolCalls"),
    ],
  ],
  [
    // agents.md:84 and agents.md:318 type maxSessionTurns as an optional number, so null is not a value it takes.
    // validateAgentDefinition in @standardagents/spec accepts null, and the spec text decides. Neighbors: 3 and absent.
    "rejects maxSessionTurns: null and accepts a number or no maxSessionTurns",
    "max-session-turns-null",
    [error("agents/agents/nulled.ts:maxSessionTurns")],
  ],
  [
    // agents.md:41 and agents.md:287 type stopOnResponse as boolean. Neighbors: false and absent.
    "rejects a string stopOnResponse and accepts false or no stopOnResponse",
    "stop-on-response-string",
    [error("agents/agents/stringly.ts:sideA.stopOnResponse")],
  ],
  [
    // subagents.md:12-30 types every option of a relationship, and SubagentRelationship in index.d.ts:4546 agrees.
    // Neighbor: legal_coordinator sets every option legally, with immediate as true, false, and the object form.
    "rejects each relationship option of the wrong type and accepts every option with a legal value",
    "subagent-options",
    [
      error("agents/agents/coordinator.ts:sideA.subagents[0].description"),
      error("agents/agents/coordinator.ts:sideA.subagents[1].immediate"),
      error("agents/agents/coordinator.ts:sideA.subagents[2].immediate.nameEnv"),
      error("agents/agents/coordinator.ts:sideA.subagents[3].immediate.scopedEnv"),
      error("agents/agents/coordinator.ts:sideA.subagents[4].blocking"),
      error("agents/agents/coordinator.ts:sideA.subagents[5].parentCommunication"),
      error("agents/agents/coordinator.ts:sideA.subagents[6].scopedEnv"),
      error("agents/agents/coordinator.ts:sideA.subagents[7].initUserMessageProperty"),
      error("agents/agents/coordinator.ts:sideA.subagents[8].initAttachmentsProperty"),
      error("agents/agents/coordinator.ts:sideA.subagents[9].initAgentNameProperty"),
      error("agents/agents/coordinator.ts:sideA.subagents[10].optional"),
      error("agents/agents/coordinator.ts:sideA.subagents[11].hidden"),
    ],
  ],
  [
    // packaging.md:197-198: __meta.version is the package version in semver. Neighbors: 0.3.1 and
    // 1.2.3-beta.1+build.5. The path follows the existing __meta convention of validate.ts, which names a field of
    // __meta without the export name, as in parentHooks.<agent>.
    "rejects a __meta.version that is not semver and accepts a plain or prerelease semver",
    "package-version-semver",
    [error("agents/packed/standardagent-loose-version/index.js:version")],
  ],
  [
    // packaging.md:183-185, 205-206, and 210-213: each parentHooks disclosure duplicates the parentHooks of an entry
    // agent, keyed by that agent. A key for no entry agent, or for an entry agent with no parentHooks, duplicates
    // nothing. Neighbor: a package that discloses {} in both places for an entry agent with no parentHooks.
    "rejects a parent hook disclosure for no entry agent or for an entry agent without parentHooks",
    "stray-parent-hooks",
    [
      error("agents/packed/standardagent-extra-disclosure/package.json:standardagent.parentHooks.opener"),
      error("agents/packed/standardagent-ghost-disclosure/index.js:parentHooks.ghost"),
    ],
  ],
  [
    // ToolArgs in index.d.ts:275-282: "Tool arguments MUST be defined as a Zod object schema." ToolDefinition.args
    // (index.d.ts:534) is ToolArgs or null. Neighbors: a Zod object, null, and no args.
    "rejects tool args that are not a Zod object schema and accepts a Zod object, null, or no args",
    "tool-args-shape",
    [error("agents/tools/json_schema_args.ts:args"), error("agents/tools/string_args.ts:args")],
  ],
  [
    // effects.md:95-101: the second element of an EffectDefinition is ToolArgs | null, a Zod object schema or null.
    // The tuple's second element is its args, so the path is [1]. Neighbors: a Zod object and defineEffect without args.
    "rejects effect args that are not a Zod object schema or null and accepts both",
    "effect-args-shape",
    [error("agents/effects/plain_args.ts:[1]"), error("agents/effects/string_args.ts:[1]")],
  ],
  [
    // prompts.md:30 types requiredSchema as ZodSchema, and PromptDefinition (index.d.ts:4309, 4367) bounds it by
    // ToolArgs, a Zod object schema. Neighbors: a Zod object and no requiredSchema.
    "rejects a requiredSchema that is not a Zod object schema and accepts a Zod object or none",
    "required-schema-shape",
    [error("agents/prompts/plain_schema.ts:requiredSchema"), error("agents/prompts/string_schema.ts:requiredSchema")],
  ],
  [
    // agents.md:42 and agents.md:288: stopTool names the tool whose call stops the turn. packaging.md:232-236: a
    // qualified name resolves only through an installed package. With no package standardagent-absent, the stop can
    // never happen. Neighbors: a local stopTool, and a packed agent whose stopTool is its own package's qualified tool.
    "rejects a stopTool qualified by a package that is not installed and accepts a local or installed one",
    "stop-tool-missing-package",
    [error("agents/agents/absent_package.ts:sideA.stopTool")],
  ],
]

describe("validate shapes", () => {
  for (const [title, name, expected] of shapes)
    it.effect(title, () =>
      Effect.gen(function* () {
        const { issues } = yield* validateFixture(`invalid/${name}`)
        expect(located(issues)).toEqual([...expected].sort())
      }).pipe(Effect.provide(PlatformLive)),
    )

  // packaging.md:168, 180, and 199-200 give package.json and __meta each a list of the callable entry agents. No
  // sentence makes a disagreement an error, so the test asks only that it be reported at the field and leaves the
  // severity to the build. Neighbor: the same two agents in another order, which declares the same set.
  it.effect("reports a package.json entryAgents list that disagrees with __meta.entryAgents", () =>
    Effect.gen(function* () {
      const { issues } = yield* validateFixture("invalid/entry-agents-disagree")
      expect(issues.map(location)).toEqual([
        "agents/packed/standardagent-disagree/package.json:standardagent.entryAgents",
      ])
    }).pipe(Effect.provide(PlatformLive)),
  )
})

describe("validate messages", () => {
  // The definition helpers of @standardagents/spec, such as defineAgent, throw one "<path>: <message>" line per
  // issue. Other code throws its own text, and a message shaped like "word: text" is still one message. Neighbor:
  // gate.ts throws from defineAgent, and its two lines are still reported at their fields.
  it.effect("reports an error message shaped like word: text as a message and not as a field path", () =>
    Effect.gen(function* () {
      const { issues } = yield* validateFixture("invalid/colon-message")
      expect(located(issues)).toEqual(
        [
          error("agents/agents/gate.ts:maxSessionTurns"),
          error("agents/agents/gate.ts:sideB"),
          error("agents/packed/standardagent-colon/index.js:tools.lookup"),
          error("agents/tools/flaky.ts"),
        ].sort(),
      )
      const message = (file: string) => issues.find((issue) => location(issue) === file)?.message
      expect(message("agents/tools/flaky.ts")).toContain("timeout: the upstream did not answer")
      expect(message("agents/packed/standardagent-colon/index.js:tools.lookup")).toContain(
        "network: the registry is unreachable",
      )
    }).pipe(Effect.provide(PlatformLive)),
  )

  // A broken link is a fault of the project, so the message names the link and nothing inside Spindle's own build,
  // whose path means nothing to the author. Neighbor: a link to a file outside the kind directories loads.
  it.effect("names a broken symlink under agents/ and no file inside Spindle's own build", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const runtime = yield* path.fromFileUrl(new URL("../../", import.meta.url))
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-symlink-" })
      yield* fs.makeDirectory(path.join(root, "agents", "tools"), { recursive: true })
      yield* fs.makeDirectory(path.join(root, "agents", "shared"), { recursive: true })
      yield* fs.writeFileString(
        path.join(root, "agents", "shared", "lookup.ts"),
        'export default { description: "Looks a word up", execute: async () => ({ status: "success" }) }\n',
      )
      yield* fs.symlink("../shared/lookup.ts", path.join(root, "agents", "tools", "linked.ts"))
      yield* fs.symlink("./missing-target.ts", path.join(root, "agents", "tools", "dangling.ts"))
      const { issues } = yield* validateRoot(root)
      expect(located(issues)).toEqual([error("agents/tools/dangling.ts")])
      const [broken] = issues
      expect(broken?.message).toContain("dangling.ts")
      expect(broken?.message).not.toContain(runtime)
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
  )
})
