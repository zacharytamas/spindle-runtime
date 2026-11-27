import { DEFINITION_ISSUE_CODES, type NamespaceContext, type PackageSignature } from "@standardagents/spec"
import type { Effect } from "effect"
import type { LoadError } from "./import-file.ts"

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

const SPINDLE_ISSUE_CODES = [
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

const ISSUE_CODES = [...DEFINITION_ISSUE_CODES, ...SPINDLE_ISSUE_CODES] as const
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

export const namespaceOf = (definition: Definition): NamespaceContext =>
  definition.package === undefined
    ? { type: "global" }
    : { type: "packed", packageId: definition.package.signature.packageId }
