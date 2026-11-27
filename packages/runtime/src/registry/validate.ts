import { parseQualifiedName, RESERVED_RELATIONSHIP_NAMES, validateAgentDefinition } from "@standardagents/spec"
import { Effect } from "effect"
import {
  type Definition,
  describeCause,
  type Issue,
  type IssueCode,
  KINDS,
  type Kind,
  namespaceOf,
  Registry,
} from "./Registry.ts"
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

const isRecord = (value: unknown): value is Shape =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== ""

const isOneOf = (allowed: ReadonlyArray<string>, value: unknown) => typeof value === "string" && allowed.includes(value)

const isStringArray = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const backingOf = (side: Shape) => {
  const present = (["human", "prompt", "handler"] as const).filter((key) => side[key] !== undefined)
  return present.length === 1 ? present[0] : undefined
}

interface Edge {
  readonly target: Definition
  readonly path: string
}

type Edges = ReadonlyMap<Definition, ReadonlyArray<Edge>>

const cyclesOf = (edges: Edges) => {
  const cycles: Array<{ readonly cycle: ReadonlyArray<Definition>; readonly path: string }> = []
  const done = new Set<Definition>()
  const visit = (definition: Definition, trail: ReadonlyArray<Definition>) => {
    if (done.has(definition)) return
    const start = trail.indexOf(definition)
    if (start !== -1) {
      const cycle = trail.slice(start)
      const edge = edges.get(definition)?.find((e) => e.target === (cycle[1] ?? definition))
      cycles.push({ cycle, path: edge?.path ?? "" })
      return
    }
    for (const edge of edges.get(definition) ?? []) visit(edge.target, [...trail, definition])
    done.add(definition)
  }
  for (const definition of [...edges.keys()].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)))
    visit(definition, [])
  return cycles
}

// A caller reads inherited fields too, so keys come from for...in.
const keysOf = (value: Shape) => {
  const keys: Array<string> = []
  for (const key in value) keys.push(key)
  return keys
}

// Array.from reads a missing element as undefined, where every() would skip it.
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      Array.from(a, (item, i) => sameValue(item, b[i])).every(Boolean)
    )
  if (isRecord(a) && isRecord(b)) {
    const keys = keysOf(a)
    const other = keysOf(b)
    return keys.length === other.length && keys.every((key) => other.includes(key) && sameValue(a[key], b[key]))
  }
  return Object.is(a, b)
}

const listed = (names: ReadonlyArray<string>) => `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

export interface Validation {
  readonly definitions: ReadonlyArray<Definition>
  readonly issues: ReadonlyArray<Issue>
}

export const validate = Effect.gen(function* () {
  const registry = yield* Registry
  const issues: Array<Issue> = [...registry.issues]
  const loaded = registry.loaded

  const site = (definition: Definition) => {
    const report = (code: IssueCode, path: string, message: string, severity: Issue["severity"] = "error"): void => {
      issues.push({
        code,
        severity,
        message,
        file: definition.file,
        path: [definition.path, path].filter((part) => part !== "").join("."),
      })
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
    return { report, resolve, describe, snakeCase, hookList }
  }

  const loadedFound = (resolution: Resolution) =>
    resolution._tag === "Found" ? loaded.get(resolution.definition) : undefined

  const toolNames = (prompt: unknown): Array<string> =>
    isRecord(prompt) && Array.isArray(prompt.tools)
      ? prompt.tools.flatMap((entry) => {
          const name = typeof entry === "string" ? entry : isRecord(entry) ? entry.name : undefined
          return typeof name === "string" ? [parseQualifiedName(name)[1]] : []
        })
      : []

  const checkAgent = (definition: Definition, agent: unknown) => {
    const at = site(definition)
    for (const issue of validateAgentDefinition(agent)) at.report(issue.code, issue.path, issue.message, issue.severity)
    if (!isRecord(agent)) return
    at.snakeCase()
    for (const sideKey of ["sideA", "sideB"]) {
      const side = agent[sideKey]
      if (!isRecord(side)) continue
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
      if (backing === "prompt" && isNonEmptyString(side.prompt)) {
        const resolution = at.resolve("prompt", side.prompt)
        if (resolution._tag !== "Found")
          at.report("agent_prompt_undefined", `${sideKey}.prompt`, at.describe("prompt", side.prompt, resolution))
        toolsOfSide = toolNames(loadedFound(resolution))
      }
      if (backing === "handler" && isNonEmptyString(side.handler)) {
        const resolution = at.resolve("handler", side.handler)
        if (resolution._tag !== "Found")
          at.report("agent_handler_undefined", `${sideKey}.handler`, at.describe("handler", side.handler, resolution))
      }
      if (backing === "human" || !Array.isArray(side.subagents)) continue
      side.subagents.forEach((relationship: unknown, index) => {
        if (!isRecord(relationship) || !isNonEmptyString(relationship.agent)) return
        const path = `${sideKey}.subagents[${index}]`
        const resolution = at.resolve("agent", relationship.agent)
        if (resolution._tag !== "Found")
          at.report("subagent_agent_undefined", `${path}.agent`, at.describe("agent", relationship.agent, resolution))
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
        if (!isRecord(requirement) || !isNonEmptyString(requirement.hook)) continue
        const resolution = at.resolve("hook", requirement.hook)
        if (resolution._tag === "Found") {
          const earlier = spellings.get(resolution.definition)
          if (earlier === undefined) spellings.set(resolution.definition, requirement.hook)
          else if (earlier !== requirement.hook)
            at.report(
              "agent_parent_hooks_invalid",
              `parentHooks[${index}].hook`,
              `parentHooks names hook ${earlier} again as ${requirement.hook}`,
            )
        } else
          at.report(
            "hook_undefined",
            `parentHooks[${index}].hook`,
            `${at.describe("hook", requirement.hook, resolution)}. A required parent hook must be defined in the agent's own namespace.`,
          )
      }
  }

  const checkPrompt = (definition: Definition, prompt: unknown) => {
    const at = site(definition)
    if (!isRecord(prompt)) return at.report("prompt_content_invalid", "", "A prompt definition must be an object")
    if (!isNonEmptyString(prompt.name)) at.report("prompt_name_missing", "name", "name must be a non-empty string")
    at.snakeCase()
    if (!isNonEmptyString(prompt.toolDescription))
      at.report("prompt_tool_description_missing", "toolDescription", "toolDescription must be a non-empty string")
    let model: unknown
    if (!isNonEmptyString(prompt.model)) at.report("prompt_model_undefined", "model", "model must name a defined model")
    else {
      const resolution = at.resolve("model", prompt.model)
      if (resolution._tag === "Found") model = loaded.get(resolution.definition)
      else at.report("prompt_model_undefined", "model", at.describe("model", prompt.model, resolution))
    }
    if (Array.isArray(prompt.prompt)) {
      for (const [index, part] of (prompt.prompt as Array<unknown>).entries()) {
        const path = `prompt[${index}]`
        const valid =
          isRecord(part) &&
          ((part.type === "text" && typeof part.content === "string") ||
            (part.type === "include" && isNonEmptyString(part.prompt)) ||
            (part.type === "env" && isNonEmptyString(part.property)))
        if (!valid) {
          at.report(
            "prompt_content_invalid",
            path,
            `${path} must be a text part with content, an include part with prompt, or an env part with property`,
          )
          continue
        }
        if (part.type !== "include" || !isNonEmptyString(part.prompt)) continue
        const resolution = at.resolve("prompt", part.prompt)
        if (resolution._tag !== "Found")
          at.report("prompt_include_undefined", `${path}.prompt`, at.describe("prompt", part.prompt, resolution))
      }
    } else if (typeof prompt.prompt !== "string")
      at.report("prompt_content_invalid", "prompt", "prompt must be a string or an array of prompt parts")
    if (prompt.toolChoice !== undefined && !isOneOf(["auto", "none", "required"], prompt.toolChoice))
      at.report("prompt_tool_choice_invalid", "toolChoice", "toolChoice must be one of auto, none, or required")
    if (prompt.reasoning !== undefined) {
      const level = isRecord(prompt.reasoning) ? prompt.reasoning.level : undefined
      if (
        !isRecord(prompt.reasoning) ||
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
    const providerTools = isRecord(model) && isStringArray(model.providerTools) ? model.providerTools : []
    if (prompt.tools !== undefined && !Array.isArray(prompt.tools))
      at.report("prompt_tool_undefined", "tools", "tools must be an array")
    if (Array.isArray(prompt.tools))
      for (const [index, entry] of (prompt.tools as Array<unknown>).entries()) {
        const path = `tools[${index}]`
        if (isRecord(entry)) {
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
        const name = typeof entry === "string" ? entry : isRecord(entry) ? entry.name : undefined
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
        const tool = at.resolve("tool", name)
        if (tool._tag === "Found") continue
        const subprompt = at.resolve("prompt", name)
        if (subprompt._tag === "Found") continue
        const agent = at.resolve("agent", name)
        if (agent._tag === "Found") {
          const target = loaded.get(agent.definition)
          if (isRecord(target) && target.exposeAsTool !== true)
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
        const hidden = [tool, subprompt, agent].find((resolution) => resolution._tag === "Hidden")
        at.report("prompt_tool_undefined", path, at.describe("tool", name, hidden ?? tool))
      }
    at.hookList("hooks", prompt.hooks)
  }

  const checkModel = (definition: Definition, model: unknown) => {
    const at = site(definition)
    if (!isRecord(model)) return at.report("model_property_invalid", "", "A model definition must be an object")
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
    if (model.capabilities !== undefined && !isRecord(model.capabilities))
      at.report("model_property_invalid", "capabilities", "capabilities must be an object")
    if (isStringArray(model.fallbacks))
      model.fallbacks.forEach((name, index) => {
        const resolution = at.resolve("model", name)
        if (resolution._tag !== "Found")
          at.report("model_fallback_undefined", `fallbacks[${index}]`, at.describe("model", name, resolution))
        else if (resolution.definition === definition)
          at.report(
            "model_fallback_self",
            `fallbacks[${index}]`,
            `fallbacks names model ${name} itself. A fallback must name another model.`,
          )
      })
    const schema =
      typeof model.provider === "function"
        ? (model.provider as { providerOptions?: unknown }).providerOptions
        : undefined
    // The provider's schema decides the type of providerOptions, which may be a scalar. Without one, it is an object.
    if (model.providerOptions !== undefined && isRecord(schema) && typeof schema.safeParse === "function") {
      const parsed: unknown = schema.safeParse(model.providerOptions)
      if (isRecord(parsed) && parsed.success === false)
        at.report(
          "model_provider_options_invalid",
          "providerOptions",
          `providerOptions do not match the provider's schema: ${describeCause(parsed.error)}`,
        )
    } else if (model.providerOptions !== undefined && !isRecord(model.providerOptions))
      at.report("model_property_invalid", "providerOptions", "providerOptions must be an object")
  }

  const checkTool = (definition: Definition, tool: unknown) => {
    const at = site(definition)
    at.snakeCase()
    if ((RESERVED_RELATIONSHIP_NAMES as ReadonlyArray<string>).includes(definition.name))
      at.report(
        "tool_name_reserved",
        "",
        `Tool name ${definition.name} is reserved for the injected lifecycle tools (${RESERVED_RELATIONSHIP_NAMES.join(", ")})`,
      )
    if (!isRecord(tool)) return at.report("tool_invalid", "", "A tool definition must be an object from defineTool()")
    if (typeof tool.execute !== "function") at.report("tool_invalid", "execute", "execute must be a function")
    if (typeof tool.description !== "string") at.report("tool_invalid", "description", "description must be a string")
    if (tool.uses === undefined || tool.uses === null) return
    if (!isStringArray(tool.uses)) return at.report("tool_invalid", "uses", "uses must be an array of names")
    tool.uses.forEach((name, index) => {
      const resolutions = (["tool", "prompt", "agent"] as const).map((kind) => at.resolve(kind, name))
      if (resolutions.some((resolution) => resolution._tag === "Found")) return
      const hidden = resolutions.find((resolution) => resolution._tag === "Hidden")
      at.report("tool_uses_undefined", `uses[${index}]`, at.describe("tool", name, hidden ?? { _tag: "Missing" }))
    })
  }

  const checkHook = (definition: Definition, hook: unknown) => {
    const at = site(definition)
    if (!isRecord(hook))
      return at.report("hook_type_invalid", "", "A hook definition must be an object from defineHook()")
    if (!isOneOf(THREAD_HOOKS, hook.hook))
      at.report("hook_type_invalid", "hook", `hook must be one of ${THREAD_HOOKS.join(", ")}`)
    if (!isNonEmptyString(hook.id) || !SNAKE_CASE.test(hook.id))
      at.report("hook_id_invalid", "id", "id must be a snake_case string")
    if (typeof hook.execute !== "function") at.report("hook_execute_missing", "execute", "execute must be a function")
  }

  const checkHandler = (definition: Definition, handler: unknown) => {
    const at = site(definition)
    if (!isRecord(handler))
      return at.report("handler_invalid", "", "A handler definition must be an object from defineHandler()")
    if (typeof handler.execute !== "function") at.report("handler_invalid", "execute", "execute must be a function")
    if (handler.description !== undefined && typeof handler.description !== "string")
      at.report("handler_invalid", "description", "description must be a string")
  }

  const checkEffect = (definition: Definition, effect: unknown) => {
    const at = site(definition)
    at.snakeCase()
    const valid =
      Array.isArray(effect) &&
      effect.length === 3 &&
      typeof effect[0] === "string" &&
      (effect[1] === null || isRecord(effect[1])) &&
      typeof effect[2] === "function"
    if (!valid)
      at.report(
        "effect_invalid",
        "",
        "An effect must be the [description, args, handler] tuple that defineEffect() returns",
      )
  }

  const checks: Record<Kind, (definition: Definition, value: unknown) => void> = {
    agent: checkAgent,
    prompt: checkPrompt,
    tool: checkTool,
    model: checkModel,
    hook: checkHook,
    handler: checkHandler,
    effect: checkEffect,
  }
  const edgesTo = (
    definition: Definition,
    targets: ReadonlyArray<readonly [name: unknown, path: string]>,
  ): ReadonlyArray<Edge> =>
    targets.flatMap(([name, path]) => {
      if (!isNonEmptyString(name)) return []
      const resolution = registry.resolve(definition.kind, name, namespaceOf(definition))
      return resolution._tag === "Found" ? [{ target: resolution.definition, path }] : []
    })

  const includes = new Map<Definition, ReadonlyArray<Edge>>()
  const fallbacks = new Map<Definition, ReadonlyArray<Edge>>()
  for (const [definition, value] of loaded) {
    try {
      checks[definition.kind](definition, value)
      if (definition.kind === "prompt" && isRecord(value))
        includes.set(
          definition,
          edgesTo(
            definition,
            Array.isArray(value.prompt)
              ? value.prompt.map(
                  (part: unknown, index) =>
                    [
                      isRecord(part) && part.type === "include" ? part.prompt : undefined,
                      `prompt[${index}].prompt`,
                    ] as const,
                )
              : [],
          ),
        )
      if (definition.kind === "model" && isRecord(value))
        fallbacks.set(
          definition,
          edgesTo(
            definition,
            isStringArray(value.fallbacks)
              ? value.fallbacks.map((name, index) => [name, `fallbacks[${index}]`] as const)
              : [],
          ),
        )
    } catch (cause) {
      site(definition).report(
        "definition_load_failed",
        "",
        `The ${definition.kind} threw while Spindle checked it. ${describeCause(cause)}`,
      )
    }
  }

  for (const { cycle, path } of cyclesOf(includes)) {
    const names = cycle.map((d) => d.qualifiedName)
    site(cycle[0] as Definition).report(
      "prompt_include_circular",
      path,
      cycle.length === 1
        ? `Prompt ${names[0]} includes itself`
        : `Prompts ${listed(names)} include each other (${[...names, names[0]].join(" -> ")})`,
    )
  }

  for (const { cycle, path } of cyclesOf(fallbacks).filter(({ cycle }) => cycle.length > 1)) {
    const names = cycle.map((d) => d.qualifiedName)
    site(cycle[0] as Definition).report(
      "model_fallback_circular",
      path,
      `Models ${listed(names)} name each other as fallbacks (${[...names, names[0]].join(" -> ")}). A fallback chain that returns to its first model does not end.`,
      "warning",
    )
  }

  for (const pkg of registry.packages) {
    try {
      for (const agentName of pkg.entryAgents) {
        const definition = registry.definitions.find(
          (d) => d.package === pkg && d.kind === "agent" && d.name === agentName,
        )
        const agent = definition && loaded.get(definition)
        if (!isRecord(agent) || agent.parentHooks === undefined) continue
        const sources = [
          ["__meta", "parentHooks", pkg.meta.parentHooks, pkg.file],
          [
            "package.json",
            "standardagent.parentHooks",
            isRecord(pkg.manifest.standardagent) ? pkg.manifest.standardagent.parentHooks : undefined,
            pkg.manifestFile,
          ],
        ] as const
        for (const [label, field, value, file] of sources) {
          const copy = isRecord(value) ? value[agentName] : undefined
          if (!sameValue(copy, agent.parentHooks))
            issues.push({
              code: "package_parent_hooks_mismatch",
              severity: "error",
              message: `${pkg.signature.packageId} must reproduce the parentHooks of entry agent ${agentName} in ${label}`,
              file,
              path: `${field}.${agentName}`,
            })
        }
      }
    } catch (cause) {
      issues.push({
        code: "package_invalid",
        severity: "error",
        message: `${pkg.signature.packageId} threw while Spindle compared its parentHooks disclosures. ${describeCause(cause)}`,
        file: pkg.file,
        path: "",
      })
    }
  }

  const order = (issue: Issue) => `${issue.file}\u0000${issue.path}\u0000${issue.code}`
  issues.sort((a, b) => order(a).localeCompare(order(b)))
  return { definitions: registry.definitions, issues } satisfies Validation
})

export const counts = (definitions: ReadonlyArray<Definition>) =>
  Object.fromEntries(KINDS.map((kind) => [kind, definitions.filter((d) => d.kind === kind).length])) as Record<
    Kind,
    number
  >
