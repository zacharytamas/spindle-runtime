import type {
  AttachmentRef,
  Message,
  PromptDefinition,
  ProviderAssistantMessage,
  ProviderMessage,
  ProviderReasoningDetail,
  ProviderRequest,
  ProviderToolCallPart,
} from "@standardagents/spec"
import { Effect } from "effect"
import type { Definition } from "../registry/Registry.ts"
import { type EnvScope, resolveEnv } from "./env.ts"
import { type Loaded, lookup, roleOf, SetupError, type Side, type Turn } from "./turn.ts"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export const promptScope = (turn: Turn): EnvScope => ({
  agent: turn.agent.value.env,
  toolEntry: undefined,
  prompt: turn.prompt.value.env,
})

// Prompts section 2.4: only the prompt field of an included prompt is inserted, so every env part resolves
// against the variables and env of the prompt being rendered, never those of the included one. Prompts section
// 2.1: a declared text variable whose value holds a known secret still never enters the system prompt.
export const renderSystemPrompt = Effect.fn("renderSystemPrompt")(function* (turn: Turn, secrets: ReadonlySet<string>) {
  const root = turn.prompt
  const variables = root.value.variables ?? []
  const scope = promptScope(turn)
  for (const variable of variables)
    if (variable.required && (yield* resolveEnv(scope, variable.name)) === undefined)
      return yield* new SetupError({
        message: `Prompt ${root.definition.qualifiedName} requires variable ${variable.name}, which has no value`,
      })
  const render = (
    prompt: Loaded<PromptDefinition>,
    trail: ReadonlyArray<Definition>,
  ): Effect.Effect<string, SetupError, import("../registry/Registry.ts").Registry> =>
    Effect.gen(function* () {
      if (typeof prompt.value.prompt === "string") return prompt.value.prompt
      let text = ""
      for (const part of prompt.value.prompt) {
        if (part.type === "text") text += part.content
        else if (part.type === "include") {
          const included = yield* lookup<PromptDefinition>("prompt", part.prompt, prompt.definition)
          if (included === undefined)
            return yield* new SetupError({
              message: `Prompt ${prompt.definition.qualifiedName} includes ${part.prompt}, which is not defined`,
            })
          if (trail.includes(included.definition))
            return yield* new SetupError({
              message: `Prompts include each other: ${[...trail, included.definition].map((d) => d.qualifiedName).join(" -> ")}`,
            })
          text += yield* render(included, [...trail, included.definition])
        } else {
          const variable = variables.find((candidate) => candidate.name === part.property)
          if (variable === undefined || variable.type !== "text")
            return yield* new SetupError({
              message: `Prompt ${root.definition.qualifiedName} interpolates ${part.property}, which it does not declare as a text variable. A system prompt holds only declared text variables, never a secret.`,
            })
          const value = (yield* resolveEnv(scope, part.property)) ?? ""
          if ([...secrets].some((secret) => secret !== "" && value.includes(secret)))
            return yield* new SetupError({
              message: `Prompt ${root.definition.qualifiedName} interpolates variable ${part.property}, whose value is a secret. A system prompt never holds a secret.`,
            })
          text += value
        }
      }
      return text
    })
  return yield* render(root, [root.definition])
})

export interface HistoryView {
  readonly side: Side
  // The message from the other side that started this turn. It and everything after it form the current exchange.
  readonly turnStart: string | undefined
  readonly includeChat: boolean
  readonly includePastTools: boolean
  readonly includeReasoning: boolean
  readonly acceptsDetails: (message: Message) => boolean
}

export const toolCallsOf = (message: Message): Array<ProviderToolCallPart> => {
  const parsed = message.tool_calls == null ? undefined : parseJson(message.tool_calls)
  if (!Array.isArray(parsed)) return []
  const extra =
    isRecord(message.metadata) && isRecord(message.metadata.tool_call_extra) ? message.metadata.tool_call_extra : {}
  return parsed.flatMap((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || !isRecord(entry.function)) return []
    const args = typeof entry.function.arguments === "string" ? parseJson(entry.function.arguments) : undefined
    const extraContent = extra[entry.id]
    return [
      {
        id: entry.id,
        name: String(entry.function.name),
        arguments: isRecord(args) ? args : {},
        ...(isRecord(extraContent) ? { extraContent } : {}),
      },
    ]
  })
}

const describeAttachment = (ref: AttachmentRef) => {
  const size = ref.width !== undefined && ref.height !== undefined ? `, ${ref.width}x${ref.height}` : ""
  const description = ref.description === undefined ? "" : `: ${ref.description}`
  return `[Attachment ${ref.name} (${ref.mimeType}${size}) at ${ref.path}${description}]`
}

// The thread file system arrives in M3. Until then no attachment bytes exist, so every reference reaches
// the model as the text description that Prompts section 7 gives older images.
const textOf = (message: Message) =>
  [message.content ?? "", ...(message.attachments ?? []).map(describeAttachment)]
    .filter((part) => part !== "")
    .join("\n")

const reasoningOf = (message: Message, view: HistoryView): Partial<ProviderAssistantMessage> => {
  if (!view.includeReasoning) return {}
  const details =
    message.reasoning_details == null || !view.acceptsDetails(message)
      ? undefined
      : parseJson(message.reasoning_details)
  return {
    ...(message.reasoning_content == null ? {} : { reasoning: message.reasoning_content }),
    ...(Array.isArray(details) ? { reasoningDetails: details as Array<ProviderReasoningDetail> } : {}),
  }
}

// Read once when the execution starts, so that a message a tool injects later cannot move the start of the turn.
export const turnStartOf = (history: ReadonlyArray<Message>, side: Side) =>
  history.findLast((message) => message.role === roleOf(side === "a" ? "b" : "a"))?.id

// Runtime section 4: a side's own turns are assistant turns, the other side's are user turns, and the other
// side's tool calls stay hidden. History before the message that started the turn is past history, which
// includeChat and includePastTools admit. A call and its result are shown or hidden together.
export const toProviderMessages = (history: ReadonlyArray<Message>, view: HistoryView): Array<ProviderMessage> => {
  const own = roleOf(view.side)
  const other = roleOf(view.side === "a" ? "b" : "a")
  const current = Math.max(
    0,
    history.findIndex((message) => message.id === view.turnStart),
  )
  const shownCalls = new Map<string, boolean>()
  const messages: Array<ProviderMessage> = []
  history.forEach((message, index) => {
    const past = index < current
    if (message.role === "tool") {
      if (shownCalls.get(message.tool_call_id ?? "") !== true) return
      const text = textOf(message)
      messages.push({
        role: "tool",
        toolCallId: message.tool_call_id ?? "",
        toolName: message.name ?? "",
        content: message.tool_status === "error" ? { type: "error", error: text } : text,
      })
    } else if (message.role === "system") {
      if (!past || view.includeChat) messages.push({ role: "system", content: message.content ?? "" })
    } else if (message.role === other) {
      for (const call of toolCallsOf(message)) shownCalls.set(call.id, false)
      if (!past || view.includeChat) messages.push({ role: "user", content: textOf(message) })
    } else if (message.role === own) {
      const calls = toolCallsOf(message)
      const showCalls = calls.length > 0 && (!past || view.includePastTools)
      for (const call of calls) shownCalls.set(call.id, showCalls)
      const content = !past || view.includeChat ? message.content : null
      if (past && !showCalls && (content ?? "") === "") return
      messages.push({
        role: "assistant",
        content,
        ...(showCalls ? { toolCalls: calls } : {}),
        ...reasoningOf(message, view),
      })
    }
  })
  return messages
}

export const buildRequest = (
  turn: Turn,
  system: string,
  messages: ReadonlyArray<ProviderMessage>,
  signal: AbortSignal,
): ProviderRequest => {
  const prompt = turn.prompt.value
  const model = turn.model.value
  const tools = [...turn.tools.values()].map((tool) => tool.definition)
  const reasoning = prompt.reasoning
  const levels = model.capabilities?.reasoningLevels
  const providerOptions =
    model.providerOptions === undefined && prompt.providerOptions === undefined
      ? undefined
      : { ...model.providerOptions, ...prompt.providerOptions }
  return {
    model: model.model,
    messages: [{ role: "system", content: system }, ...messages],
    ...(tools.length === 0 ? {} : { tools }),
    ...(tools.length === 0 || prompt.toolChoice === undefined ? {} : { toolChoice: prompt.toolChoice }),
    ...(prompt.parallelToolCalls === undefined ? {} : { parallelToolCalls: prompt.parallelToolCalls }),
    ...(reasoning === undefined
      ? {}
      : {
          reasoning: {
            ...(reasoning.level === undefined ? {} : { level: reasoning.level }),
            ...(reasoning.level === undefined || levels === undefined ? {} : { levels }),
            ...(reasoning.maxTokens === undefined ? {} : { maxTokens: reasoning.maxTokens }),
            ...(reasoning.exclude === undefined ? {} : { exclude: reasoning.exclude }),
          },
        }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
    signal,
  }
}
