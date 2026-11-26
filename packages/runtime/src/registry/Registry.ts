import { DEFINITION_ISSUE_CODES, type NamespaceContext, type PackageSignature } from "@standardagents/spec"
import { Context, Data, Effect, type FileSystem, Layer, type Path } from "effect"
import { loadDirectory } from "./load-directory.ts"
import { loadPackages } from "./load-packages.ts"
import { type Resolution, resolver } from "./resolve.ts"

export const KINDS = ["agent", "prompt", "tool", "model", "hook", "handler", "effect"] as const
export type Kind = (typeof KINDS)[number]

export const PLURAL = {
  agent: "agents",
  prompt: "prompts",
  tool: "tools",
  model: "models",
  hook: "hooks",
  handler: "handlers",
  effect: "effects",
} as const satisfies Record<Kind, string>

export const SPINDLE_ISSUE_CODES = [
  "agents_directory_missing",
  "definition_load_failed",
  "definition_export_missing",
  "definition_name_mismatch",
  "definition_name_duplicate",
  "definition_name_not_snake_case",
  "agent_prompt_undefined",
  "agent_handler_undefined",
  "subagent_agent_undefined",
  "subagent_relationship_tool_collision",
  "hook_undefined",
  "hook_reference_is_handler",
  "prompt_name_missing",
  "prompt_tool_description_missing",
  "prompt_model_undefined",
  "prompt_content_invalid",
  "prompt_include_undefined",
  "prompt_include_circular",
  "prompt_tool_undefined",
  "prompt_tool_is_handler",
  "prompt_tool_subagent_relationship",
  "prompt_tool_agent_not_exposed",
  "prompt_tool_choice_invalid",
  "prompt_reasoning_level_invalid",
  "prompt_recent_image_threshold_invalid",
  "model_name_invalid",
  "model_provider_invalid",
  "model_id_missing",
  "model_property_invalid",
  "model_fallback_undefined",
  "model_fallback_self",
  "model_fallback_circular",
  "model_provider_options_invalid",
  "tool_invalid",
  "tool_name_reserved",
  "tool_uses_undefined",
  "hook_type_invalid",
  "hook_id_invalid",
  "hook_execute_missing",
  "handler_invalid",
  "effect_invalid",
  "package_invalid",
  "package_meta_invalid",
  "package_duplicate",
  "package_entry_agent_undefined",
  "package_keyword_missing",
  "package_name_prefix",
  "package_parent_hooks_mismatch",
] as const

export const ISSUE_CODES = [...DEFINITION_ISSUE_CODES, ...SPINDLE_ISSUE_CODES] as const
export type IssueCode = (typeof ISSUE_CODES)[number]

export interface Issue {
  readonly code: IssueCode
  readonly severity: "error" | "warning"
  readonly message: string
  readonly file: string
  readonly path: string
}

export interface Package {
  readonly signature: PackageSignature
  readonly entryAgents: ReadonlyArray<string>
  readonly file: string
  readonly manifestFile: string
  readonly manifest: Readonly<Record<string, unknown>>
  readonly meta: Readonly<Record<string, unknown>>
}

export interface Definition {
  readonly kind: Kind
  readonly name: string
  readonly qualifiedName: string
  readonly package: Package | undefined
  readonly file: string
  readonly path: string
  readonly load: Effect.Effect<unknown, LoadError>
}

export class LoadError extends Data.TaggedError("LoadError")<{ readonly issues: ReadonlyArray<Issue> }> {}

export const namespaceOf = (definition: Definition): NamespaceContext =>
  definition.package === undefined
    ? { type: "global" }
    : { type: "packed", packageId: definition.package.signature.packageId }

export class Registry extends Context.Service<
  Registry,
  {
    readonly root: string
    readonly definitions: ReadonlyArray<Definition>
    readonly packages: ReadonlyArray<Package>
    readonly issues: ReadonlyArray<Issue>
    readonly resolve: (kind: Kind, name: string, from: NamespaceContext) => Resolution
  }
>()("spindle/Registry") {
  static readonly layer = (root: string): Layer.Layer<Registry, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      Registry,
      Effect.gen(function* () {
        const local = yield* loadDirectory(root)
        const packed = yield* loadPackages(root)
        const definitions = [...local.definitions, ...packed.definitions]
        return {
          root,
          definitions,
          packages: packed.packages,
          issues: [...local.issues, ...packed.issues],
          resolve: resolver(definitions),
        }
      }),
    )
}

const TYPESCRIPT_SYNTAX =
  "The file uses TypeScript syntax that Node cannot strip, such as an enum, a namespace, or a constructor parameter property. Node removes type annotations but does not transform code. Rewrite it with erasable syntax, for example a union of string literals in place of an enum."
const NODE_MODULES_TYPESCRIPT =
  "The file is a TypeScript file inside node_modules, and Node does not strip types from files there. Publish the package as JavaScript."

export const describeCause = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

export const describeImportFailure = (cause: unknown): string => {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined
  if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") return TYPESCRIPT_SYNTAX
  if (code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING") return NODE_MODULES_TYPESCRIPT
  return `The file failed to load. ${describeCause(cause).split("\n")[0]}`
}

// The definition helpers in @standardagents/spec, such as defineAgent, throw one "<path>: <message>" line per issue.
const FIELD_LINE = /^([A-Za-z_$][\w$]*(?:\.[\w$]+|\[\d+\])*): (.+)$/

const importFailureIssues = (file: string, cause: unknown): ReadonlyArray<Issue> => {
  const lines = describeCause(cause)
    .split("\n")
    .map((line) => FIELD_LINE.exec(line))
  const fields = lines.flatMap((match) => (match === null ? [] : [match]))
  const issue = (path: string, message: string): Issue => ({
    code: "definition_load_failed",
    severity: "error",
    message,
    file,
    path,
  })
  return fields.length === lines.length
    ? fields.map(([, path = "", message = ""]) => issue(path, `The file failed to load. ${message}`))
    : [issue("", describeImportFailure(cause))]
}

export const importFile = (file: string, url: Effect.Effect<URL, unknown>) =>
  url.pipe(
    Effect.flatMap((href) =>
      Effect.tryPromise({
        try: (): Promise<Record<string, unknown>> => import(href.href),
        catch: (cause) => cause,
      }),
    ),
    Effect.mapError((cause) => new LoadError({ issues: importFailureIssues(file, cause) })),
  )
