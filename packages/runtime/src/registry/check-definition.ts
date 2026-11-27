import { parseQualifiedName, RESERVED_RELATIONSHIP_NAMES, validateAgentDefinition } from "@standardagents/spec"
import { Predicate } from "effect"
import { type Definition, type Issue, issue, type Kind, namespaceOf } from "./definition.ts"
import { describeCause } from "./load-error.ts"
import type { Registry } from "./Registry.ts"
import type { Resolution } from "./resolve.ts"

const THREAD_HOOKS = [
  "after_thread_created",
  "after_subagent_created",
  "after_system_message",
  "filter_messages",
  "prefilter_llm_history",
  "before_create_message",
  "after_create_message",
  "before_update_message",
  "after_update_message",
  "before_store_tool_result",
  "tool_call_started",
  "after_tool_call_success",
  "after_tool_call_failure",
  "tool_call_done",
]

const RELATIONSHIP_ONLY_KEYS = [
  "agent",
  "as",
  "maxInstances",
  "immediate",
  "blocking",
  "parentCommunication",
  "scopedEnv",
  "initAgentNameProperty",
  "optional",
  "hidden",
  "resumable",
  "receives_messages",
]

const HUMAN_SIDE_KEYS = ["human", "label"]

const REPORTED_BY_SPEC_PACKAGE = [
  "subagents",
  "stopOnResponse",
  "stopTool",
  "stopToolResponseProperty",
  "maxSteps",
  "sessionStop",
  "sessionFail",
  "sessionStatus",
]

const SNAKE_CASE = /^[a-z][a-z0-9_]*$/

type Shape = Record<string, unknown>

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== ""

const isOneOf = (allowed: ReadonlyArray<string>, value: unknown) => typeof value === "string" && allowed.includes(value)

const isStringArray = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const hasName = <K extends string>(object: Shape, key: K): object is Shape & Record<K, string> =>
  isNonEmptyString(object[key])

const backingOf = (side: Shape) => {
  const present = (["human", "prompt", "handler"] as const).filter((key) => side[key] !== undefined)
  return present.length === 1 ? present[0] : undefined
}

export interface Edge {
  readonly target: Definition
  readonly path: string
}

export const site = (registry: Registry["Service"], issues: Array<Issue>, definition: Definition) => {
  const report = (code: Issue["code"], path: string, message: string, severity: Issue["severity"] = "error"): void => {
    issues.push(
      issue(code, definition.file, [definition.path, path].filter((part) => part !== "").join("."), message, severity),
    )
  }
  const from = namespaceOf(definition)
  const resolve = (kind: Kind, name: string) => registry.resolve(kind, name, from)
  const describe = (kind: Kind, name: string, resolution: Resolution) =>
    resolution._tag === "Hidden"
      ? `${kind} ${name} is internal to package ${resolution.definition.package?.signature.packageId}, so ${definition.kind} ${definition.qualifiedName} cannot see it`
      : `${kind} ${name} is not defined`
  const snakeCase = () => {
    if (!SNAKE_CASE.test(definition.name))
      report(
        "definition_name_not_snake_case",
        "",
        `${definition.kind} name ${definition.name} should use snake_case`,
        "warning",
      )
  }
  const hookList = (field: string, value: unknown) => {
    if (value === undefined) return
    if (!isStringArray(value)) return report("hook_undefined", field, `${field} must be an array of hook ids`)
    for (const [index, id] of value.entries()) {
      const resolution = resolve("hook", id)
      if (resolution._tag === "Found") continue
      if (resolve("handler", id)._tag === "Found")
        report(
          "hook_reference_is_handler",
          `${field}[${index}]`,
          `${field} names handler ${id}. A handler backs an agent side and cannot be used as a hook.`,
        )
      else report("hook_undefined", `${field}[${index}]`, describe("hook", id, resolution))
    }
  }
  // The diagnostic reads the authored name again only when lookup fails. It can be a getter.
  const reference = (kind: Kind, read: () => string, code: Issue["code"], path: string, suffix = "") => {
    const found = resolve(kind, read())
    if (found._tag === "Found") return found.definition
    report(code, path, describe(kind, read(), found) + suffix)
  }
  const tool = (name: string): Resolution => {
    let missing: Resolution = { _tag: "Missing" }
    for (const kind of ["tool", "prompt", "agent"] as const) {
      const result = resolve(kind, name)
      if (result._tag === "Found") return result
      if (missing._tag === "Missing") missing = result
    }
    return missing
  }
  return { definition, report, resolve, reference, tool, describe, snakeCase, hookList }
}

type Site = ReturnType<typeof site>

const edgesTo = (at: Site, targets: ReadonlyArray<readonly [name: unknown, path: string]>): ReadonlyArray<Edge> =>
  targets.flatMap(([name, path]) => {
    if (!isNonEmptyString(name)) return []
    const resolution = at.resolve(at.definition.kind, name)
    return resolution._tag === "Found" ? [{ target: resolution.definition, path }] : []
  })

const toolNames = (prompt: unknown): Array<string> =>
  Predicate.isObject(prompt) && Array.isArray(prompt.tools)
    ? prompt.tools.flatMap((entry) => {
        const name = typeof entry === "string" ? entry : Predicate.isObject(entry) ? entry.name : undefined
        return typeof name === "string" ? [parseQualifiedName(name)[1]] : []
      })
    : []

const checkAgent = (at: Site, agent: unknown) => {
  for (const issue of validateAgentDefinition(agent)) at.report(issue.code, issue.path, issue.message, issue.severity)
  if (!Predicate.isObject(agent)) return
  at.snakeCase()
  for (const sideKey of ["sideA", "sideB"]) {
    const side = agent[sideKey]
    if (!Predicate.isObject(side)) continue
    const backing = backingOf(side)
    if (side.label !== undefined && typeof side.label !== "string")
      at.report("agent_side_invalid", `${sideKey}.label`, "label must be a string")
    if (backing === "human") {
      for (const key of Object.keys(side)) {
        if (HUMAN_SIDE_KEYS.includes(key) || REPORTED_BY_SPEC_PACKAGE.includes(key)) continue
        at.report(
          "agent_side_option_invalid_for_backing",
          `${sideKey}.${key}`,
          `'${key}' is not legal on a human-backed side. A human side takes only human and label.`,
        )
      }
    }
    let toolsOfSide: Array<string> = []
    if (backing === "prompt" && hasName(side, "prompt"))
      toolsOfSide = toolNames(
        at.reference("prompt", () => side.prompt, "agent_prompt_undefined", `${sideKey}.prompt`)?.value,
      )
    if (backing === "handler" && hasName(side, "handler"))
      at.reference("handler", () => side.handler, "agent_handler_undefined", `${sideKey}.handler`)
    if (backing === "human" || !Array.isArray(side.subagents)) continue
    side.subagents.forEach((relationship: unknown, index) => {
      if (!Predicate.isObject(relationship) || !hasName(relationship, "agent")) return
      const path = `${sideKey}.subagents[${index}]`
      at.reference("agent", () => relationship.agent, "subagent_agent_undefined", `${path}.agent`)
      if (isNonEmptyString(relationship.as) && relationship.as.includes("/"))
        at.report(
          "subagent_relationship_invalid",
          `${path}.as`,
          `Relationship name ${relationship.as} contains a slash. A relationship name is a tool name and cannot contain one.`,
        )
      const name = isNonEmptyString(relationship.as) ? relationship.as : parseQualifiedName(relationship.agent)[1]
      if (toolsOfSide.includes(name))
        at.report(
          "subagent_relationship_tool_collision",
          `${path}.as`,
          `Relationship name ${name} collides with a tool of the same name in the prompt of ${sideKey}. Choose another 'as' name.`,
        )
    })
  }
  at.hookList("hooks", agent.hooks)
  // validateAgentDefinition reports two equal spellings, so this check reports only another spelling of one hook.
  const spellings = new Map<Definition, string>()
  const required: unknown = agent.parentHooks
  if (Array.isArray(required))
    for (const [index, requirement] of Array.from(required as Array<unknown>).entries()) {
      // validateAgentDefinition uses forEach, which skips a missing element, so this check reports it.
      if (!(index in required)) {
        at.report("agent_parent_hooks_invalid", `parentHooks[${index}]`, "parentHooks entries must be objects")
        continue
      }
      if (!Predicate.isObject(requirement) || !hasName(requirement, "hook")) continue
      const target = at.reference(
        "hook",
        () => requirement.hook,
        "hook_undefined",
        `parentHooks[${index}].hook`,
        ". A required parent hook must be defined in the agent's own namespace.",
      )
      if (!target) continue
      const earlier = spellings.get(target)
      if (earlier === undefined) spellings.set(target, requirement.hook)
      else if (earlier !== requirement.hook)
        at.report(
          "agent_parent_hooks_invalid",
          `parentHooks[${index}].hook`,
          `parentHooks names hook ${earlier} again as ${requirement.hook}`,
        )
    }
}

const checkPrompt = (at: Site, prompt: unknown) => {
  if (!Predicate.isObject(prompt))
    return at.report("prompt_content_invalid", "", "A prompt definition must be an object")
  if (!isNonEmptyString(prompt.name)) at.report("prompt_name_missing", "name", "name must be a non-empty string")
  at.snakeCase()
  if (!isNonEmptyString(prompt.toolDescription))
    at.report("prompt_tool_description_missing", "toolDescription", "toolDescription must be a non-empty string")
  let model: unknown
  if (!hasName(prompt, "model")) at.report("prompt_model_undefined", "model", "model must name a defined model")
  else model = at.reference("model", () => prompt.model, "prompt_model_undefined", "model")?.value
  if (Array.isArray(prompt.prompt)) {
    for (const [index, part] of (prompt.prompt as Array<unknown>).entries()) {
      const path = `prompt[${index}]`
      const valid =
        Predicate.isObject(part) &&
        ((part.type === "text" && typeof part.content === "string") ||
          (part.type === "include" && hasName(part, "prompt")) ||
          (part.type === "env" && isNonEmptyString(part.property)))
      if (!valid) {
        at.report(
          "prompt_content_invalid",
          path,
          `${path} must be a text part with content, an include part with prompt, or an env part with property`,
        )
        continue
      }
      if (part.type !== "include" || !hasName(part, "prompt")) continue
      at.reference("prompt", () => part.prompt, "prompt_include_undefined", `${path}.prompt`)
    }
  } else if (typeof prompt.prompt !== "string")
    at.report("prompt_content_invalid", "prompt", "prompt must be a string or an array of prompt parts")
  if (prompt.toolChoice !== undefined && !isOneOf(["auto", "none", "required"], prompt.toolChoice))
    at.report("prompt_tool_choice_invalid", "toolChoice", "toolChoice must be one of auto, none, or required")
  if (prompt.reasoning !== undefined) {
    const level = Predicate.isObject(prompt.reasoning) ? prompt.reasoning.level : undefined
    if (
      !Predicate.isObject(prompt.reasoning) ||
      (level !== undefined && !(typeof level === "number" && level >= 0 && level <= 100))
    )
      at.report("prompt_reasoning_level_invalid", "reasoning.level", "reasoning.level must be a number from 0 to 100")
  }
  const threshold = prompt.recentImageThreshold
  if (threshold !== undefined && !(typeof threshold === "number" && Number.isInteger(threshold) && threshold > 0))
    at.report(
      "prompt_recent_image_threshold_invalid",
      "recentImageThreshold",
      "recentImageThreshold must be a positive integer",
    )
  const providerTools = Predicate.isObject(model) && isStringArray(model.providerTools) ? model.providerTools : []
  if (prompt.tools !== undefined && !Array.isArray(prompt.tools))
    at.report("prompt_tool_undefined", "tools", "tools must be an array")
  if (Array.isArray(prompt.tools))
    for (const [index, entry] of (prompt.tools as Array<unknown>).entries()) {
      const path = `tools[${index}]`
      if (Predicate.isObject(entry)) {
        const keys = Object.keys(entry).filter((key) => RELATIONSHIP_ONLY_KEYS.includes(key))
        if (keys.length > 0) {
          at.report(
            "prompt_tool_subagent_relationship",
            path,
            `${path} configures a subagent relationship (${keys.join(", ")}). Declare relationships in the subagents array of the agent side that owns them.`,
          )
          continue
        }
      }
      const name = typeof entry === "string" ? entry : Predicate.isObject(entry) ? entry.name : undefined
      if (!isNonEmptyString(name)) {
        at.report("prompt_tool_undefined", path, `${path} must be a tool name or an object with a name`)
        continue
      }
      if ((RESERVED_RELATIONSHIP_NAMES as ReadonlyArray<string>).includes(parseQualifiedName(name)[1])) {
        at.report(
          "tool_name_reserved",
          path,
          `${path} names ${name}, which is reserved for the injected lifecycle tools (${RESERVED_RELATIONSHIP_NAMES.join(", ")})`,
        )
        continue
      }
      const tool = at.tool(name)
      if (tool._tag === "Found") {
        const target = tool.definition.value
        if (tool.definition.kind === "agent" && Predicate.isObject(target) && target.exposeAsTool !== true)
          at.report(
            "prompt_tool_agent_not_exposed",
            path,
            `${path} names agent ${name}, which does not set exposeAsTool: true`,
          )
        continue
      }
      if (providerTools.includes(name)) continue
      if (at.resolve("handler", name)._tag === "Found") {
        at.report(
          "prompt_tool_is_handler",
          path,
          `${path} names handler ${name}. A handler backs an agent side and cannot be a prompt tool.`,
        )
        continue
      }
      at.report("prompt_tool_undefined", path, at.describe("tool", name, tool))
    }
  at.hookList("hooks", prompt.hooks)
  return edgesTo(
    at,
    Array.isArray(prompt.prompt)
      ? prompt.prompt.map(
          (part: unknown, i) =>
            [
              Predicate.isObject(part) && part.type === "include" ? part.prompt : undefined,
              `prompt[${i}].prompt`,
            ] as const,
        )
      : [],
  )
}

const checkModel = (at: Site, model: unknown) => {
  if (!Predicate.isObject(model)) return at.report("model_property_invalid", "", "A model definition must be an object")
  if (!isNonEmptyString(model.name) || /\s/.test(model.name))
    at.report("model_name_invalid", "name", "name must be a non-empty string without spaces")
  if (typeof model.provider !== "function")
    at.report("model_provider_invalid", "provider", "provider must be a provider factory function")
  if (!isNonEmptyString(model.model)) at.report("model_id_missing", "model", "model must be a non-empty string")
  for (const field of ["inputPrice", "outputPrice", "cachedPrice"]) {
    const price = model[field]
    if (price !== undefined && !(typeof price === "number" && price >= 0))
      at.report("model_property_invalid", field, `${field} must be a non-negative number`)
  }
  for (const field of ["includedProviders", "providerTools", "fallbacks"]) {
    if (model[field] !== undefined && !isStringArray(model[field]))
      at.report("model_property_invalid", field, `${field} must be an array of strings`)
  }
  if (model.capabilities !== undefined && !Predicate.isObject(model.capabilities))
    at.report("model_property_invalid", "capabilities", "capabilities must be an object")
  if (isStringArray(model.fallbacks))
    model.fallbacks.forEach((name, index) => {
      const target = at.reference("model", () => name, "model_fallback_undefined", `fallbacks[${index}]`)
      if (target === at.definition)
        at.report(
          "model_fallback_self",
          `fallbacks[${index}]`,
          `fallbacks names model ${name} itself. A fallback must name another model.`,
        )
    })
  const schema =
    typeof model.provider === "function" ? (model.provider as { providerOptions?: unknown }).providerOptions : undefined
  // The provider's schema decides the type of providerOptions, which may be a scalar. Without one, it is an object.
  if (model.providerOptions !== undefined && Predicate.isObject(schema) && typeof schema.safeParse === "function") {
    const parsed: unknown = schema.safeParse(model.providerOptions)
    if (Predicate.isObject(parsed) && parsed.success === false)
      at.report(
        "model_provider_options_invalid",
        "providerOptions",
        `providerOptions do not match the provider's schema: ${describeCause(parsed.error)}`,
      )
  } else if (model.providerOptions !== undefined && !Predicate.isObject(model.providerOptions))
    at.report("model_property_invalid", "providerOptions", "providerOptions must be an object")
  return edgesTo(
    at,
    isStringArray(model.fallbacks) ? model.fallbacks.map((name, i) => [name, `fallbacks[${i}]`] as const) : [],
  )
}

const checkTool = (at: Site, tool: unknown) => {
  at.snakeCase()
  if ((RESERVED_RELATIONSHIP_NAMES as ReadonlyArray<string>).includes(at.definition.name))
    at.report(
      "tool_name_reserved",
      "",
      `Tool name ${at.definition.name} is reserved for the injected lifecycle tools (${RESERVED_RELATIONSHIP_NAMES.join(", ")})`,
    )
  if (!Predicate.isObject(tool))
    return at.report("tool_invalid", "", "A tool definition must be an object from defineTool()")
  if (typeof tool.execute !== "function") at.report("tool_invalid", "execute", "execute must be a function")
  if (typeof tool.description !== "string") at.report("tool_invalid", "description", "description must be a string")
  if (tool.uses === undefined || tool.uses === null) return
  if (!isStringArray(tool.uses)) return at.report("tool_invalid", "uses", "uses must be an array of names")
  tool.uses.forEach((name, index) => {
    const target = at.tool(name)
    if (target._tag !== "Found") at.report("tool_uses_undefined", `uses[${index}]`, at.describe("tool", name, target))
  })
}

const checkHook = (at: Site, hook: unknown) => {
  if (!Predicate.isObject(hook))
    return at.report("hook_type_invalid", "", "A hook definition must be an object from defineHook()")
  if (!isOneOf(THREAD_HOOKS, hook.hook))
    at.report("hook_type_invalid", "hook", `hook must be one of ${THREAD_HOOKS.join(", ")}`)
  if (!isNonEmptyString(hook.id) || !SNAKE_CASE.test(hook.id))
    at.report("hook_id_invalid", "id", "id must be a snake_case string")
  if (typeof hook.execute !== "function") at.report("hook_execute_missing", "execute", "execute must be a function")
}

const checkHandler = (at: Site, handler: unknown) => {
  if (!Predicate.isObject(handler))
    return at.report("handler_invalid", "", "A handler definition must be an object from defineHandler()")
  if (typeof handler.execute !== "function") at.report("handler_invalid", "execute", "execute must be a function")
  if (handler.description !== undefined && typeof handler.description !== "string")
    at.report("handler_invalid", "description", "description must be a string")
}

const checkEffect = (at: Site, effect: unknown) => {
  at.snakeCase()
  const valid =
    Array.isArray(effect) &&
    effect.length === 3 &&
    typeof effect[0] === "string" &&
    (effect[1] === null || Predicate.isObject(effect[1])) &&
    typeof effect[2] === "function"
  if (!valid)
    at.report(
      "effect_invalid",
      "",
      "An effect must be the [description, args, handler] tuple that defineEffect() returns",
    )
}

export const checks: Record<Kind, (at: Site, value: unknown) => void | ReadonlyArray<Edge>> = {
  agent: checkAgent,
  prompt: checkPrompt,
  tool: checkTool,
  model: checkModel,
  hook: checkHook,
  handler: checkHandler,
  effect: checkEffect,
}
