import type {
  AgentDefinition,
  ModelDefinition,
  PromptDefinition,
  PromptSide,
  PromptToolConfig,
  ProviderTool,
  ThreadState,
  ToolArgs,
  VariableDefinition,
} from "@standardagents/spec"
import { Data, Effect } from "effect"
import { type Definition, type Kind, namespaceOf } from "../registry/definition.ts"
import { Registry } from "../registry/Registry.ts"

export class SetupError extends Data.TaggedError("SetupError")<{ readonly message: string }> {}

export interface Loaded<A> {
  readonly definition: Definition
  readonly value: A
}

export type Side = "a" | "b"

// Messages section 4 and Agents section 1.3: a stored role is a side's perspective, user for B and assistant for A.
export const roleOf = (side: Side) => (side === "a" ? "assistant" : "user")

export interface FunctionTool {
  readonly description: string
  readonly args: ToolArgs | null
  readonly execute: (state: ThreadState, args?: unknown) => Promise<unknown>
  readonly variables?: ReadonlyArray<VariableDefinition>
  readonly uses?: ReadonlyArray<string> | null
  readonly progressArgument?: string
}

export interface ExposedTool {
  readonly name: string
  readonly tool: Loaded<FunctionTool>
  readonly entry: PromptToolConfig | undefined
  readonly definition: ProviderTool
}

export interface Turn {
  readonly agent: Loaded<AgentDefinition>
  readonly side: Side
  readonly human: Side
  readonly config: PromptSide
  readonly prompt: Loaded<PromptDefinition>
  readonly model: Loaded<ModelDefinition>
  readonly tools: ReadonlyMap<string, ExposedTool>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isFunctionTool = (value: unknown): value is FunctionTool =>
  isRecord(value) &&
  typeof value.execute === "function" &&
  typeof value.description === "string" &&
  (value.args === null ||
    value.args === undefined ||
    (isRecord(value.args) && typeof value.args.safeParseAsync === "function"))

export const lookup = Effect.fn("lookup")(function* <A>(kind: Kind, name: string, from: Definition | undefined) {
  const registry = yield* Registry
  const resolution = registry.resolve(kind, name, from === undefined ? { type: "global" } : namespaceOf(from))
  if (resolution._tag !== "Found" || !registry.loaded.has(resolution.definition)) return undefined
  return { definition: resolution.definition, value: registry.loaded.get(resolution.definition) as A } as Loaded<A>
})

const backingOf = (side: unknown) => {
  if (!isRecord(side)) return "nothing"
  if (side.human === true) return "human"
  if (typeof side.prompt === "string") return "prompt"
  if (typeof side.handler === "string") return "handler"
  return "nothing"
}

export const sidesOf = Effect.fn("sidesOf")(function* (agentName: string) {
  const agent = yield* lookup<AgentDefinition>("agent", agentName, undefined)
  if (agent === undefined) return yield* new SetupError({ message: `No agent named ${agentName} is defined` })
  const a = backingOf(agent.value.sideA)
  const b = backingOf(agent.value.sideB)
  if (!((a === "human" && b === "prompt") || (a === "prompt" && b === "human")))
    return yield* new SetupError({
      message: `Agent ${agentName} has a ${a} side A and a ${b} side B. This version of Spindle runs one prompt side against one human side.`,
    })
  const side: Side = a === "prompt" ? "a" : "b"
  const config = (side === "a" ? agent.value.sideA : agent.value.sideB) as PromptSide
  return { agent, side, human: side === "a" ? ("b" as const) : ("a" as const), config }
})

const parametersOf = (args: ToolArgs | null): Record<string, unknown> => {
  if (args === null) return { type: "object", properties: {} }
  const { $schema: _, ...schema } = args.toJSONSchema({ io: "input" })
  return schema
}

const exposedTools = Effect.fn("exposedTools")(function* (
  prompt: Loaded<PromptDefinition>,
  model: Loaded<ModelDefinition>,
) {
  const tools = new Map<string, ExposedTool>()
  for (const entry of prompt.value.tools ?? []) {
    const name = typeof entry === "string" ? entry : entry.name
    const found = yield* lookup<unknown>("tool", name, prompt.definition)
    if (found === undefined || !isFunctionTool(found.value)) {
      const other =
        (yield* lookup("prompt", name, prompt.definition)) !== undefined
          ? "a prompt tool"
          : (yield* lookup("agent", name, prompt.definition)) !== undefined
            ? "an agent handoff"
            : (model.value.providerTools ?? []).includes(name)
              ? "a provider tool"
              : undefined
      return yield* new SetupError({
        message:
          other === undefined
            ? `Prompt ${prompt.definition.qualifiedName} lists tool ${name}, which is not a defined function tool`
            : `Prompt ${prompt.definition.qualifiedName} lists ${name}, which is ${other}. This version of Spindle runs function tools only.`,
      })
    }
    const tool = found as Loaded<FunctionTool>
    if (tools.has(tool.definition.name))
      return yield* new SetupError({
        message: `Prompt ${prompt.definition.qualifiedName} lists two tools named ${tool.definition.name}`,
      })
    const parameters = yield* Effect.try({
      try: () => parametersOf(tool.value.args ?? null),
      catch: (cause) =>
        new SetupError({
          message: `The arguments of tool ${tool.definition.qualifiedName} have no JSON Schema form: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    })
    tools.set(tool.definition.name, {
      name: tool.definition.name,
      tool,
      entry: typeof entry === "string" ? undefined : (entry as PromptToolConfig),
      definition: {
        type: "function",
        function: { name: tool.definition.name, description: tool.value.description, parameters },
      },
    })
  }
  return tools
})

// The model calls a tool by the name the prompt offers it under, the short name of its definition. A stopTool may be
// a qualified name such as pack/finish, so the stop rule compares calls with the offered name of the tool it resolves to.
const exposedStopTool = Effect.fn("exposedStopTool")(function* (
  config: PromptSide,
  agent: Loaded<AgentDefinition>,
  tools: ReadonlyMap<string, ExposedTool>,
) {
  if (config.stopTool === undefined) return config
  const target = yield* lookup<unknown>("tool", config.stopTool, agent.definition)
  const exposed = [...tools.values()].find((tool) => tool.tool.definition === target?.definition)
  return exposed === undefined ? config : { ...config, stopTool: exposed.name }
})

export const prepareTurn = Effect.fn("prepareTurn")(function* (agentName: string) {
  const { agent, side, human, config } = yield* sidesOf(agentName)
  const prompt = yield* lookup<PromptDefinition>("prompt", config.prompt, agent.definition)
  if (prompt === undefined)
    return yield* new SetupError({ message: `Agent ${agentName} names prompt ${config.prompt}, which is not defined` })
  const model = yield* lookup<ModelDefinition>("model", prompt.value.model, prompt.definition)
  if (model === undefined)
    return yield* new SetupError({
      message: `Prompt ${prompt.definition.qualifiedName} names model ${prompt.value.model}, which is not defined`,
    })
  const tools = yield* exposedTools(prompt, model)
  if (prompt.value.toolChoice === "required" && tools.size === 0)
    return yield* new SetupError({
      message: `Prompt ${prompt.definition.qualifiedName} sets toolChoice to required but lists no tools`,
    })
  return {
    agent,
    side,
    human,
    config: yield* exposedStopTool(config, agent, tools),
    prompt,
    model,
    tools,
  } satisfies Turn
})
