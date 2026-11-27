import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { PlatformLive } from "#platform"
import type { Issue } from "../../src/registry/definition.ts"
import { describeImportFailure } from "../../src/registry/import-file.ts"
import { Registry } from "../../src/registry/Registry.ts"
import { counts, validate } from "../../src/registry/validate.ts"

const fixture = (name: string) =>
  Path.Path.pipe(
    Effect.flatMap((path) => path.fromFileUrl(new URL(`../../../conformance/fixtures/${name}`, import.meta.url))),
  )

const validateRoot = (root: string) => validate.pipe(Effect.provide(Registry.layer(root)))

const validateFixture = (name: string) => fixture(name).pipe(Effect.flatMap(validateRoot))

const brokenManifest = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = path.join(yield* fs.makeTempDirectoryScoped({ prefix: "spindle-registry-" }), "project")
  yield* fs.copy(yield* fixture("invalid/broken-manifest"), root)
  yield* fs.makeDirectory(path.join(root, "agents", "packed", "sample"), { recursive: true })
  yield* fs.writeFileString(path.join(root, "agents", "packed", "sample", "package.json"), "{")
  return root
})

const located = (issues: ReadonlyArray<Issue>) =>
  issues.map((issue) => [issue.code, issue.path === "" ? issue.file : `${issue.file}:${issue.path}`, issue.severity])

const error = (code: string, location: string) => [code, location, "error"]
const warning = (code: string, location: string) => [code, location, "warning"]

type Case = readonly [title: string, fixture: string, expected: ReadonlyArray<ReadonlyArray<string>>]

const invalid: ReadonlyArray<Case> = [
  [
    "rejects an agent whose two sides are both human",
    "both-sides-human",
    [error("agent_both_sides_human", "agents/agents/both_human.ts:sideB")],
  ],
  [
    "rejects an agent without a name",
    "agent-name-missing",
    [error("agent_name_missing", "agents/agents/nameless.ts:name")],
  ],
  [
    "rejects a side that sets both prompt and handler",
    "two-backings",
    [error("agent_side_backing_conflict", "agents/agents/two_backings.ts:sideA")],
  ],
  [
    "rejects a side with no backing and an agent with one side",
    "no-backing",
    [
      error("agent_side_backing_missing", "agents/agents/no_backing.ts:sideA"),
      error("agent_side_missing", "agents/agents/one_side.ts:sideB"),
    ],
  ],
  [
    "rejects subagents on a human side",
    "subagents-on-human",
    [error("agent_subagents_on_human_side", "agents/agents/coordinator.ts:sideB.subagents")],
  ],
  [
    "rejects a human side whose human is not true or that has a property other than label",
    "human-side-option",
    [
      error("agent_side_option_invalid_for_backing", "agents/agents/greeter.ts:sideB.greeting"),
      error("agent_side_invalid", "agents/agents/half_human.ts:sideA.human"),
      error("agent_side_invalid", "agents/agents/numbered.ts:sideA.label"),
      error("agent_side_invalid", "agents/agents/numbered.ts:sideB.label"),
    ],
  ],
  [
    "rejects session bindings, maxSteps, and stop bindings on a non-prompt side",
    "options-on-handler",
    [
      error("agent_side_option_invalid_for_backing", "agents/agents/bindings.ts:sideA.sessionFail"),
      error("agent_side_option_invalid_for_backing", "agents/agents/bindings.ts:sideA.sessionStatus"),
      error("agent_side_option_invalid_for_backing", "agents/agents/bindings.ts:sideA.stopTool"),
      error("agent_side_option_invalid_for_backing", "agents/agents/bindings.ts:sideA.stopToolResponseProperty"),
      error("agent_side_option_invalid_for_backing", "agents/agents/bindings.ts:sideB.maxSteps"),
      error("agent_side_option_invalid_for_backing", "agents/agents/bindings.ts:sideB.sessionStatus"),
      error("agent_side_option_invalid_for_backing", "agents/agents/relay.ts:sideA.maxSteps"),
      error("agent_side_option_invalid_for_backing", "agents/agents/relay.ts:sideA.sessionStop"),
      error("agent_side_option_invalid_for_backing", "agents/agents/relay.ts:sideA.stopOnResponse"),
      error("agent_side_option_invalid_for_backing", "agents/agents/relay.ts:sideB.stopOnResponse"),
    ],
  ],
  [
    "rejects a session binding that is a string, null, an array, or a number",
    "session-binding-string",
    [
      error("agent_session_binding_legacy_string", "agents/agents/assistant.ts:sideA.sessionStop"),
      error("agent_session_binding_invalid", "agents/agents/other_forms.ts:sideA.sessionFail.name"),
      error("agent_session_binding_invalid", "agents/agents/other_forms.ts:sideA.sessionStatus.name"),
      error("agent_session_binding_invalid", "agents/agents/other_forms.ts:sideA.sessionStop.name"),
    ],
  ],
  [
    "rejects a side that names an undefined prompt or handler",
    "undefined-backings",
    [
      error("agent_handler_undefined", "agents/agents/missing_handler.ts:sideA.handler"),
      error("agent_prompt_undefined", "agents/agents/missing_prompt.ts:sideA.prompt"),
    ],
  ],
  [
    "rejects a relationship name on both sides or equal to a tool name",
    "relationship-collisions",
    [
      error("subagent_relationship_duplicate", "agents/agents/both_sides.ts:sideB.subagents[0].as"),
      error("subagent_relationship_reserved_name", "agents/agents/reserved_names.ts:sideA.subagents[0].as"),
      error("subagent_relationship_reserved_name", "agents/agents/reserved_names.ts:sideA.subagents[1].as"),
      error("subagent_relationship_tool_collision", "agents/agents/tool_name.ts:sideA.subagents[0].as"),
    ],
  ],
  [
    "rejects a relationship named after a reserved lifecycle tool",
    "reserved-relationship",
    [error("subagent_relationship_reserved_name", "agents/agents/coordinator.ts:sideA.subagents[0].as")],
  ],
  [
    "rejects duplicate and undefined required parent hooks",
    "parent-hooks",
    [
      error("agent_parent_hooks_invalid", "agents/agents/child.ts:parentHooks[1].hook"),
      error("hook_undefined", "agents/agents/child.ts:parentHooks[2].hook"),
    ],
  ],
  [
    "rejects a parentHooks array or disclosure copy with a missing element and reads inherited fields",
    "parent-hooks-sparse",
    [
      error("agent_parent_hooks_invalid", "agents/agents/sparse_child.ts:parentHooks[1]"),
      error("package_parent_hooks_mismatch", "agents/packed/standardagent-sparse-meta/index.js:parentHooks.relay"),
    ],
  ],
  [
    "rejects a handler named in a prompt's tools",
    "handler-as-tool",
    [error("prompt_tool_is_handler", "agents/prompts/assistant.ts:tools[0]")],
  ],
  [
    "rejects a handler named in a hook list and an undefined hook",
    "hook-references",
    [
      error("hook_reference_is_handler", "agents/agents/assistant.ts:hooks[0]"),
      error("hook_undefined", "agents/prompts/assistant.ts:hooks[0]"),
      error("hook_reference_is_handler", "agents/prompts/assistant.ts:hooks[1]"),
    ],
  ],
  [
    "rejects a prompt tool or a provider tool with a reserved lifecycle tool name",
    "reserved-prompt-tool",
    [
      error("tool_name_reserved", "agents/prompts/coordinator.ts:tools[0]"),
      error("tool_name_reserved", "agents/prompts/coordinator.ts:tools[1]"),
    ],
  ],
  [
    "rejects a tools entry that configures a subagent relationship",
    "tools-subagent-config",
    [
      error("prompt_tool_subagent_relationship", "agents/prompts/coordinator.ts:tools[0]"),
      error("prompt_tool_subagent_relationship", "agents/prompts/coordinator.ts:tools[1]"),
    ],
  ],
  [
    "rejects an agent named in a prompt's tools that does not set exposeAsTool",
    "agent-tool-not-exposed",
    [error("prompt_tool_agent_not_exposed", "agents/prompts/coordinator.ts:tools[0]")],
  ],
  [
    "rejects two prompts that include each other",
    "circular-include",
    [error("prompt_include_circular", "agents/prompts/first.ts:prompt[0].prompt")],
  ],
  [
    "rejects a prompt that includes itself",
    "self-include",
    [error("prompt_include_circular", "agents/prompts/mirror.ts:prompt[0].prompt")],
  ],
  [
    "rejects a prompt without name, toolDescription, a defined model, valid content, or a defined include",
    "prompt-required-fields",
    [
      error("prompt_content_invalid", "agents/prompts/bad_content.ts:prompt[0]"),
      error("prompt_name_missing", "agents/prompts/empty_name.ts:name"),
      error("prompt_include_undefined", "agents/prompts/missing_include.ts:prompt[0].prompt"),
      error("prompt_content_invalid", "agents/prompts/no_content.ts:prompt"),
      error("prompt_tool_description_missing", "agents/prompts/no_description.ts:toolDescription"),
      error("prompt_model_undefined", "agents/prompts/no_model.ts:model"),
      error("prompt_name_missing", "agents/prompts/no_name.ts:name"),
    ],
  ],
  [
    "rejects an invalid toolChoice, reasoning level, or recentImageThreshold",
    "prompt-optional-fields",
    [
      error("prompt_tool_choice_invalid", "agents/prompts/array_choice.ts:toolChoice"),
      error("prompt_tool_choice_invalid", "agents/prompts/bad_choice.ts:toolChoice"),
      error("prompt_reasoning_level_invalid", "agents/prompts/bad_reasoning.ts:reasoning.level"),
      error("prompt_recent_image_threshold_invalid", "agents/prompts/bad_threshold.ts:recentImageThreshold"),
    ],
  ],
  [
    "rejects a model with a bad name, provider, model id, price, or fallback",
    "model-fields",
    [
      error("model_fallback_undefined", "agents/models/bad_fallback.ts:fallbacks[1]"),
      error("model_property_invalid", "agents/models/bad_price.ts:inputPrice"),
      error("model_name_invalid", "agents/models/empty_name.ts:name"),
      error("model_id_missing", "agents/models/no_model.ts:model"),
      error("model_provider_invalid", "agents/models/no_provider.ts:provider"),
      error("model_fallback_self", "agents/models/self_fallback.ts:fallbacks[0]"),
      warning("definition_name_mismatch", "agents/models/spaced_name.ts:name"),
      error("model_name_invalid", "agents/models/spaced_name.ts:name"),
    ],
  ],
  [
    "warns about models that name each other as fallbacks in a cycle",
    "model-fallback-cycle",
    [warning("model_fallback_circular", "agents/models/first.ts:fallbacks[0]")],
  ],
  [
    "rejects provider options that fail the provider's schema",
    "model-provider-options",
    [error("model_provider_options_invalid", "agents/models/bad_options.ts:providerOptions")],
  ],
  [
    "rejects a hook with an unknown type, a bad id, or no execute",
    "hook-fields",
    [
      error("hook_type_invalid", "agents/hooks/array_type.ts:hook"),
      error("hook_type_invalid", "agents/hooks/bad_type.ts:hook"),
      error("hook_id_invalid", "agents/hooks/BadId.ts:id"),
      error("hook_execute_missing", "agents/hooks/no_execute.ts:execute"),
      warning("definition_name_mismatch", "agents/hooks/other_id.ts:id"),
      error("hook_type_invalid", "agents/hooks/user_value.ts:hook"),
    ],
  ],
  [
    "warns about an identifier that differs from its file name and finds the definition by its identifier",
    "name-mismatch",
    [
      warning("definition_name_mismatch", "agents/hooks/descriptive_file.ts:id"),
      warning("definition_name_mismatch", "agents/models/backup_model.ts:name"),
      warning("definition_name_mismatch", "agents/packed/standardagent-keys/index.js:prompts.main.name"),
      warning("definition_name_mismatch", "agents/prompts/greeter.ts:name"),
    ],
  ],
  [
    "rejects malformed tools, handlers, and effects",
    "definition-shapes",
    [
      error("effect_invalid", "agents/effects/array_args.ts"),
      error("definition_export_missing", "agents/effects/no_default.ts"),
      error("effect_invalid", "agents/effects/not_a_tuple.ts"),
      error("handler_invalid", "agents/handlers/no_execute.ts:execute"),
      error("tool_uses_undefined", "agents/tools/bad_uses.ts:uses[0]"),
      error("definition_export_missing", "agents/tools/no_default.ts"),
      error("tool_invalid", "agents/tools/no_execute.ts:execute"),
      error("tool_name_reserved", "agents/tools/subagent_create.ts"),
    ],
  ],
  [
    "rejects two files that define the same name",
    "duplicate-name",
    [
      error("definition_name_duplicate", "agents/agents/relay_copy.ts"),
      warning("definition_name_mismatch", "agents/agents/relay_copy.ts:name"),
      error("definition_name_duplicate", "agents/agents/relay.ts"),
      error("definition_name_duplicate", "agents/effects/digest.ts"),
      error("definition_name_duplicate", "agents/hooks/trim_copy.ts"),
      warning("definition_name_mismatch", "agents/hooks/trim_copy.ts:id"),
      error("definition_name_duplicate", "agents/hooks/trim.ts"),
      error("definition_name_duplicate", "agents/models/quick.ts"),
      warning("definition_name_mismatch", "agents/models/quick.ts:name"),
      error("definition_name_duplicate", "agents/prompts/reply.ts"),
      warning("definition_name_mismatch", "agents/prompts/reply.ts:name"),
      error("definition_name_duplicate", "agents/tools/lookup.ts"),
    ],
  ],
  [
    "warns about names that are not snake_case",
    "naming-warnings",
    [
      warning("definition_name_not_snake_case", "agents/agents/RelayAgent.ts"),
      warning("definition_name_not_snake_case", "agents/effects/SendDigest.ts"),
      warning("definition_name_not_snake_case", "agents/prompts/MainPrompt.ts"),
      warning("definition_name_not_snake_case", "agents/tools/fetchPage.ts"),
    ],
  ],
  [
    "rejects a global prompt that names an internal tool of a package",
    "packed-internal-tool",
    [
      warning("package_name_prefix", "agents/packed/packed-a/package.json"),
      error("prompt_tool_undefined", "agents/prompts/coordinator.ts:tools[0]"),
    ],
  ],
  [
    "rejects packages with missing metadata, dependencies, entry agents, or parent hook copies",
    "package-problems",
    [
      error("hook_undefined", "agents/packed/broken/index.js:agents.relay.parentHooks[1].hook"),
      error("agent_parent_hooks_invalid", "agents/packed/broken/index.js:agents.relay.parentHooks[2].hook"),
      error("agent_handler_undefined", "agents/packed/broken/index.js:agents.relay.sideA.handler"),
      error("package_entry_agent_undefined", "agents/packed/broken/index.js"),
      error("package_parent_hooks_mismatch", "agents/packed/broken/index.js:parentHooks.relay"),
      error("definition_load_failed", "agents/packed/broken/index.js:prompts.sync_prompt"),
      error("tool_uses_undefined", "agents/packed/broken/index.js:tools.fetch_page.uses[0]"),
      error("package_keyword_missing", "agents/packed/broken/package.json"),
      error("package_parent_hooks_mismatch", "agents/packed/broken/package.json:standardagent.parentHooks.relay"),
      error("package_invalid", "agents/packed/no-manifest/package.json"),
      error("package_meta_invalid", "agents/packed/no-meta/index.js"),
      error("package_invalid", "agents/packed/no-tools/index.js:tools"),
      error("package_invalid", "agents/packed/tools-only/index.js:agents"),
      error("package_invalid", "agents/packed/tools-only/index.js:handlers"),
      error("package_invalid", "agents/packed/tools-only/index.js:hooks"),
      error("package_invalid", "agents/packed/tools-only/index.js:models"),
      error("package_invalid", "agents/packed/tools-only/index.js:prompts"),
    ],
  ],
  [
    "rejects three different errors in one pass",
    "three-errors",
    [
      error("agent_both_sides_human", "agents/agents/both_human.ts:sideB"),
      error("model_id_missing", "agents/models/conversational.ts:model"),
      error("prompt_tool_choice_invalid", "agents/prompts/assistant.ts:toolChoice"),
    ],
  ],
  [
    "reports every issue that the defineAgent helper throws",
    "define-agent-helper",
    [
      error("definition_load_failed", "agents/agents/gate.ts:maxSessionTurns"),
      error("definition_load_failed", "agents/agents/gate.ts:sideB"),
    ],
  ],
  [
    "reports every issue that the defineAgent helper throws inside a packed loader",
    "packed-define-agent",
    [
      error("definition_load_failed", "agents/packed/standardagent-gate/index.js:agents.gate.maxSessionTurns"),
      error("definition_load_failed", "agents/packed/standardagent-gate/index.js:agents.gate.sideB"),
    ],
  ],
  [
    "reports a definition that throws while it is checked and goes on",
    "throwing-getter",
    [
      error("agent_both_sides_human", "agents/agents/both_human.ts:sideB"),
      error("definition_load_failed", "agents/hooks/named_trap.ts"),
      error("definition_load_failed", "agents/tools/trap.ts"),
    ],
  ],
  [
    "reports each definition or package that throws while Spindle reads it and goes on",
    "throwing-reads",
    [
      error("agent_both_sides_human", "agents/agents/both_human.ts:sideB"),
      error("definition_load_failed", "agents/models/fallback_trap.ts"),
      error("package_invalid", "agents/packed/hooks-trap/index.js"),
      error("package_invalid", "agents/packed/meta-trap/package.json"),
      error("package_invalid", "agents/packed/registry-trap/package.json"),
      error("definition_load_failed", "agents/prompts/content_trap.ts"),
      error("definition_load_failed", "agents/tools/opaque_throw.ts"),
    ],
  ],
  [
    "rejects an empty file, a comment-only file, and a file with no export",
    "empty-files",
    [
      error("definition_export_missing", "agents/tools/comment_only.ts"),
      error("definition_export_missing", "agents/tools/emptyfile.ts"),
      error("definition_export_missing", "agents/tools/unexported.ts"),
    ],
  ],
  [
    "reports a kind directory or a package scope that is not a directory and goes on",
    "unreadable-kind",
    [
      error("agent_both_sides_human", "agents/agents/both_human.ts:sideB"),
      error("package_invalid", "agents/packed/@scope"),
      error("definition_load_failed", "agents/tools"),
    ],
  ],
  [
    "rejects a directory without an agents directory",
    "no-agents-directory",
    [error("agents_directory_missing", "agents")],
  ],
]

describe("validate", () => {
  describe("invalid fixtures", () => {
    for (const [title, name, expected] of invalid)
      it.effect(title, () =>
        Effect.gen(function* () {
          const { issues } = yield* validateFixture(`invalid/${name}`)
          expect(located(issues)).toEqual(expected)
        }).pipe(Effect.provide(PlatformLive)),
      )
  })

  describe("includes", () => {
    it.effect("rejects an include part that names no defined prompt", () =>
      Effect.gen(function* () {
        const { issues } = yield* validateFixture("invalid/prompt-required-fields")
        expect(located(issues.filter((issue) => issue.file === "agents/prompts/missing_include.ts"))).toEqual([
          error("prompt_include_undefined", "agents/prompts/missing_include.ts:prompt[0].prompt"),
        ])
      }).pipe(Effect.provide(PlatformLive)),
    )
  })

  describe("valid fixtures", () => {
    it.effect("loads one definition of every kind from agents-basic with no issues", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("agents-basic")
        expect(issues).toEqual([])
        expect(definitions.map((d) => `${d.kind} ${d.qualifiedName}`)).toEqual([
          "agent assistant",
          "agent intake",
          "agent relay",
          "prompt assistant",
          "prompt house_rules",
          "prompt summarize",
          "tool lookup",
          "model conversational",
          "hook drop_empty",
          "hook limit_history",
          "handler relay_pipe",
          "effect send_digest",
        ])
        expect(counts(definitions)).toEqual({
          agent: 3,
          prompt: 3,
          tool: 1,
          model: 1,
          hook: 2,
          handler: 1,
          effect: 1,
        })
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("accepts a human on side A and maxSessionTurns on every agent shape", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("agents-basic")
        const intake = definitions.find((d) => d.kind === "agent" && d.name === "intake")
        expect(yield* intake?.load ?? Effect.undefined).toMatchObject({
          maxSessionTurns: 4,
          sideA: { human: true },
          sideB: { handler: "relay_pipe" },
        })
        const relay = definitions.find((d) => d.kind === "agent" && d.name === "relay")
        expect(yield* relay?.load ?? Effect.undefined).not.toHaveProperty("maxSessionTurns")
        expect(issues.filter((issue) => issue.file.startsWith("agents/agents/"))).toEqual([])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("accepts maxSessionTurns, or no maxSessionTurns, on two-prompt and handler-and-prompt agents", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("session-turns")
        expect(issues).toEqual([])
        expect(definitions.filter((d) => d.kind === "agent").map((d) => d.name)).toEqual([
          "handler_and_prompt",
          "prompt_and_handler_uncapped",
          "two_prompts",
          "two_prompts_uncapped",
        ])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("accepts packaging metadata on an agent", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("agents-basic")
        const assistant = definitions.find((d) => d.kind === "agent" && d.name === "assistant")
        expect(yield* assistant?.load ?? Effect.undefined).toMatchObject({
          packageName: "agents-basic",
          version: "1.0.0",
          author: "Spindle",
          license: "MIT",
        })
        expect(issues).toEqual([])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("accepts several hooks of one type with distinct ids", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("agents-basic")
        const hooks = yield* Effect.forEach(
          definitions.filter((d) => d.kind === "hook"),
          (d) => d.load,
          { concurrency: 1 },
        )
        expect(hooks.map((hook) => (hook as { hook: string }).hook)).toEqual(["filter_messages", "filter_messages"])
        expect(issues).toEqual([])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("accepts a prompt that names a packed entry agent", () =>
      Effect.gen(function* () {
        const { issues } = yield* validateFixture("packed-entry-agent")
        expect(located(issues)).toEqual([warning("package_name_prefix", "agents/packed/packed-a/package.json")])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("accepts parent hook disclosures whose object keys are in another order", () =>
      Effect.gen(function* () {
        const { issues } = yield* validateFixture("parent-hooks-key-order")
        expect(issues).toEqual([])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect(
      "accepts a local package id, scalar provider options, a Promise from another realm, and inherited fields",
      () =>
        Effect.gen(function* () {
          const { definitions, issues } = yield* validateFixture("legal-inputs")
          expect(issues).toEqual([])
          expect(definitions.map((d) => [d.qualifiedName, d.package?.signature.packageId])).toEqual([
            ["inherited", undefined],
            ["scalar_options", undefined],
            ["local_tools/lookup", "local_tools"],
            ["standardagent-other-realm/lookup", "standardagent-other-realm"],
            ["standardagent-other-realm/inherited", "standardagent-other-realm"],
          ])
          const inherited = definitions.find((d) => d.qualifiedName === "standardagent-other-realm/inherited")
          expect(yield* inherited?.load ?? Effect.undefined).toMatchObject({
            name: "inherited",
            model: "fixture-model",
            __package: { packageId: "standardagent-other-realm" },
          })
        }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("skips declaration files next to definitions", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("declaration-files")
        expect(issues).toEqual([])
        expect(definitions.map((d) => d.file)).toEqual(["agents/models/conversational.ts"])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("resolves a scoped package id and name", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("scoped-name")
        expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
        const agent = definitions.find((d) => d.qualifiedName === "@scope/pkg/agent")
        expect(agent?.package?.signature.packageId).toBe("@scope/pkg")
        expect(agent?.name).toBe("agent")
      }).pipe(Effect.provide(PlatformLive)),
    )
  })

  describe("packages", () => {
    it.effect("discovers packages in agents/packed and keeps their names apart", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("namespace-isolation")
        expect(issues.filter((issue) => issue.severity === "error")).toEqual([])
        const tools = definitions.filter((d) => d.kind === "tool")
        expect(tools.map((d) => [d.qualifiedName, d.package?.signature.source])).toEqual([
          ["packed-a/search", "local"],
          ["packed-b/search", "local"],
        ])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("discovers packages in node_modules by their standardagent field", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-registry-" })
        yield* fs.makeDirectory(path.join(root, "agents"), { recursive: true })
        yield* fs.makeDirectory(path.join(root, "node_modules", "plain"), { recursive: true })
        yield* fs.writeFileString(path.join(root, "node_modules", "plain", "package.json"), '{ "name": "plain" }')
        yield* fs.writeFileString(
          path.join(root, "node_modules", "plain", "index.js"),
          "globalThis.spindleImportedPlainPackage = true\n",
        )
        yield* fs.copy(yield* fixture("packed-a"), path.join(root, "node_modules", "packed-a"))
        const { definitions, issues } = yield* validateRoot(root)
        expect(located(issues)).toEqual([warning("package_name_prefix", "node_modules/packed-a/package.json")])
        expect(Reflect.get(globalThis, "spindleImportedPlainPackage")).toBeUndefined()
        expect(definitions.map((d) => [d.kind, d.qualifiedName, d.package?.signature.source])).toEqual([
          ["agent", "packed-a/researcher", "npm"],
          ["prompt", "packed-a/researcher", "npm"],
          ["tool", "packed-a/search", "npm"],
          ["model", "packed-a/fast", "npm"],
        ])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    )

    it.effect("imports nothing from a package whose entry resolves outside its directory", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("invalid/package-entry-outside")
        expect(located(issues)).toEqual([
          error("package_invalid", "agents/packed/standardagent-escape-exports/package.json"),
          error("package_invalid", "agents/packed/standardagent-escape-main/package.json"),
        ])
        expect(definitions).toEqual([])
        expect(Reflect.get(globalThis, "spindleImportedOutsideEntry")).toBeUndefined()
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("loads the root entry that Node and Bun import for each exports and main shape", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("package-entries")
        expect(issues).toEqual([])
        expect(definitions.map((d) => d.qualifiedName)).toEqual([
          "standardagent-exports-array/exports_array",
          "standardagent-exports-conditions/exports_conditions",
          "standardagent-exports-dot-string/exports_dot_string",
          "standardagent-exports-nested/exports_nested",
          "standardagent-exports-order/exports_order",
          "standardagent-exports-over-main/exports_over_main",
          "standardagent-exports-string/exports_string",
          "standardagent-main-directory/main_directory",
          "standardagent-main-no-extension/main_no_extension",
        ])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("loads a package whose main is an absolute path inside the package", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-registry-" })
        const dir = path.join(root, "agents", "packed", "standardagent-exports-string")
        yield* fs.copy(path.join(yield* fixture("package-entries"), "agents"), path.join(root, "agents"))
        const manifest = path.join(dir, "package.json")
        const fields = JSON.parse(yield* fs.readFileString(manifest))
        delete fields.exports
        yield* fs.writeFileString(manifest, JSON.stringify({ ...fields, main: path.join(dir, "main.js") }))
        const { definitions, issues } = yield* validateRoot(root)
        expect(issues).toEqual([])
        expect(definitions.map((d) => d.qualifiedName)).toContain("standardagent-exports-string/exports_string")
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    )

    it.effect("rejects a package entry that Node or Bun would not import, names the package, and imports nothing", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("invalid/package-entry-shapes")
        const shapes = [
          "bare-target",
          "directory-export",
          "main-empty-directory",
          "main-missing",
          "main-number",
          "mixed-keys",
          "no-condition",
          "no-root",
          "null-condition",
          "null-root",
        ]
        expect(located(issues)).toEqual(
          shapes.map((shape) => error("package_invalid", `agents/packed/standardagent-${shape}/package.json`)),
        )
        expect(issues.map((issue) => issue.message.split(" ")[0])).toEqual(
          shapes.map((shape) => `standardagent-${shape}`),
        )
        expect(definitions).toEqual([])
        expect(Reflect.get(globalThis, "spindleImportedRejectedEntry")).toBeUndefined()
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("finds a package entry under the node export condition", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("export-conditions")
        expect(issues).toEqual([])
        expect(definitions.map((d) => d.qualifiedName)).toEqual(["standardagent-conditions/lookup"])
      }).pipe(Effect.provide(PlatformLive)),
    )

    it.effect("keeps the non-enumerable fields of a packed definition when it attaches the package signature", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-registry-" })
        const dir = path.join(root, "agents", "packed", "standardagent-hidden-fields")
        yield* fs.makeDirectory(dir, { recursive: true })
        yield* fs.writeFileString(
          path.join(dir, "package.json"),
          JSON.stringify({
            name: "standardagent-hidden-fields",
            type: "module",
            keywords: ["standardagent"],
            standardagent: {},
          }),
        )
        yield* fs.writeFileString(
          path.join(dir, "index.js"),
          [
            "const provider = () => {}",
            "export const agents = {}",
            "export const handlers = {}",
            "export const tools = {}",
            "export const hooks = {}",
            "export const prompts = {",
            '  ask: async () => ({ name: "ask", toolDescription: "Asks", model: "fast", prompt: "Answer." }),',
            "}",
            "export const models = {",
            "  speedy: async () =>",
            '    Object.defineProperties({}, { name: { value: "fast" }, provider: { value: provider }, model: { value: "m" } }),',
            "}",
            'export const __meta = { packageId: "standardagent-hidden-fields", version: "1.0.0", entryAgents: [], packedAt: 0 }',
          ].join("\n"),
        )
        const { definitions, issues } = yield* validateRoot(root)
        expect(located(issues)).toEqual([
          warning("definition_name_mismatch", "agents/packed/standardagent-hidden-fields/index.js:models.speedy.name"),
        ])
        expect(definitions.filter((d) => d.kind === "model").map((d) => d.qualifiedName)).toEqual([
          "standardagent-hidden-fields/fast",
        ])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    )

    it.effect("attaches a package signature to each packed definition of every kind at load time", () =>
      Effect.gen(function* () {
        const { definitions, issues } = yield* validateFixture("packed-every-kind")
        expect(issues).toEqual([])
        expect(definitions.map((d) => d.kind)).toEqual([
          "agent",
          "prompt",
          "tool",
          "model",
          "hook",
          "handler",
          "effect",
        ])
        const signatures = yield* Effect.forEach(
          definitions,
          (d) => d.load.pipe(Effect.map((value) => Reflect.get(Object(value), "__package"))),
          { concurrency: 1 },
        )
        expect(signatures).toEqual(
          definitions.map(() => ({
            packageId: "standardagent-every-kind",
            version: "1.0.0",
            source: "local",
            packedAt: 1764028800000,
          })),
        )
      }).pipe(Effect.provide(PlatformLive)),
    )
  })

  describe("messages", () => {
    it.effect("names the directory when it has no agents directory or does not exist", () =>
      Effect.gen(function* () {
        const root = yield* fixture("invalid/no-agents-directory")
        const missing = `${root}-absent`
        const messages = [...(yield* validateRoot(root)).issues, ...(yield* validateRoot(missing)).issues].map(
          (issue) => issue.message,
        )
        expect(messages).toEqual([
          `The directory ${root} has no agents directory. Run spindle validate on the project directory that holds agents/.`,
          `The directory ${missing} does not exist`,
        ])
      }).pipe(Effect.provide(PlatformLive)),
    )
  })

  describe("load failures", () => {
    it.effect("reports a package manifest that is not JSON and goes on to the other definitions", () =>
      Effect.gen(function* () {
        const { issues } = yield* validateRoot(yield* brokenManifest)
        expect(located(issues)).toEqual([
          error("agent_both_sides_human", "agents/agents/both_human.ts:sideB"),
          error("package_invalid", "agents/packed/sample/package.json"),
        ])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    )

    it("explains in plain words that Node cannot strip an enum", () => {
      const cause = Object.assign(new SyntaxError("TypeScript enum is not supported in strip-only mode"), {
        code: "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
      })
      expect(describeImportFailure(cause)).toMatch(/TypeScript syntax that Node cannot strip, such as an enum/)
    })
  })
})

describe("Registry", () => {
  it.effect("keeps a tool's annotations unchanged on the loaded definition", () =>
    Effect.gen(function* () {
      const root = yield* fixture("step-loop")
      const registry = yield* Effect.provide(Registry, Registry.layer(root))
      const noop = registry.definitions.find((definition) => definition.kind === "tool" && definition.name === "noop")
      const value = noop === undefined ? undefined : registry.loaded.get(noop)
      expect((value as { annotations?: unknown } | undefined)?.annotations).toEqual({
        spindle_test: { sentinel: "kept as written" },
        someone_else: { codemode: { codeArgument: "x" } },
      })
    }).pipe(Effect.provide(PlatformLive)),
  )
})
