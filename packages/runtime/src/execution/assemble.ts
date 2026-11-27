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
import type { Execution } from "./Execution.ts"
import { type EnvScope, lookupEnv, resolveEnv, type Secrets } from "./env.ts"
import type { History } from "./history.ts"
import { countHooks, has, transformHooks } from "./hooks.ts"
import { fromLLMMessage, toLLMMessage } from "./llm-history.ts"
import type { WriteContext } from "./messages.ts"
import type { StepEvents } from "./step.ts"
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
// 2.1: a system prompt holds no secret. An env part may name only a variable that the rendered prompt declares as
// text, that nothing marks secret, and that a definition supplies, and the finished text may hold no barred value.
const renderSystemPrompt = Effect.fn("renderSystemPrompt")(function* (turn: Turn, secrets: Secrets) {
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
          if (secrets.names.has(part.property))
            return yield* new SetupError({
              message: `Prompt ${root.definition.qualifiedName} interpolates variable ${part.property}, which a declaration or the provider config marks secret. A system prompt never holds a secret.`,
            })
          const found = yield* lookupEnv(scope, part.property)
          if (found?.fromInstance === true)
            return yield* new SetupError({
              message: `Prompt ${root.definition.qualifiedName} interpolates variable ${part.property}, whose value comes from the runtime instance environment. Spindle treats every instance value as secret, and a system prompt never holds a secret.`,
            })
          text += found?.value ?? ""
        }
      }
      return text
    })
  return yield* render(root, [root.definition])
})

const holdsSecret = (text: string, secrets: Secrets) =>
  [...secrets.barred].some((secret) => secret !== "" && text.includes(secret))

// Runs on the finished system prompt, after after_system_message, so that a hook cannot put a secret into it either.
const checkSystemPrompt = (turn: Turn, text: string, secrets: Secrets) =>
  holdsSecret(text, secrets)
    ? Effect.fail(
        new SetupError({
          message: `The system prompt that prompt ${turn.prompt.definition.qualifiedName} renders holds a secret value. A system prompt never holds a secret.`,
        }),
      )
    : Effect.void

// Runs after the last request hook, so that a system message that filter_messages or prefilter_llm_history adds is
// held to the rule of the system prompt.
const checkSystemMessages = (messages: ReadonlyArray<ProviderMessage>, secrets: Secrets) =>
  messages.some((message) => message.role === "system" && holdsSecret(message.content, secrets))
    ? Effect.fail(
        new SetupError({
          message:
            "A system message in the request to the model holds a secret value. A system message never holds a secret.",
        }),
      )
    : Effect.void

export interface HistoryView {
  readonly side: Side
  // The ids of the messages before the one from the other side that started this turn. A message that filter_messages
  // adds has no such id, so it belongs to the current exchange.
  readonly past: ReadonlySet<string>
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
export const pastOf = (history: ReadonlyArray<Message>, side: Side, firstDelivered?: string) => {
  const other = roleOf(side === "a" ? "b" : "a")
  const start =
    firstDelivered !== undefined
      ? history.findIndex((m) => m.id === firstDelivered)
      : history.findLastIndex((message) => message.role === other)
  return new Set(history.slice(0, Math.max(0, start)).map((message) => message.id))
}

// The chat completions format puts each result right after the message that holds its call, in the order of the
// calls. A message stored between them, such as one a tool injected while its call ran, follows the last result. A
// result belongs to the nearest earlier message that lists its call id. The stored order does not change, and the
// order is undefined when the stored order already is the request order, which is the usual case.
const NO_CALLS: Array<ProviderToolCallPart> = []

// A hook can add a message that has no stored position.
export interface RequestRow {
  readonly message: Message
  readonly seq?: number
  readonly callerSeq?: number | null
}

const requestOrder = (history: ReadonlyArray<RequestRow>, parsed: ReadonlyArray<Array<ProviderToolCallPart>>) => {
  const bySeq = new Map<number, number>()
  const holder = new Map<string, number>()
  const holderOf = ({ message, seq, callerSeq }: RequestRow, index: number) => {
    if (message.role === "tool")
      return callerSeq != null ? bySeq.get(callerSeq) : holder.get(message.tool_call_id ?? "")
    if (seq !== undefined) bySeq.set(seq, index)
    for (const call of parsed[index] ?? []) holder.set(call.id, index)
    return undefined
  }
  let last = -1
  let position = -1
  let stored = true
  history.forEach((row, index) => {
    const { message } = row
    const at = holderOf(row, index)
    if (message.role !== "tool") {
      last = index
      position = -1
    } else if (at !== undefined) {
      const next = (parsed[at] ?? []).findIndex((call) => call.id === message.tool_call_id)
      if (at !== last || next < position) stored = false
      position = next
    }
  })
  if (stored) return undefined
  holder.clear()
  const results = new Map<number, Array<number>>()
  const moved = new Set<number>()
  history.forEach((message, index) => {
    const at = holderOf(message, index)
    if (at === undefined) return
    moved.add(index)
    results.set(at, [...(results.get(at) ?? []), index])
  })
  const order: Array<number> = []
  history.forEach((_message, index) => {
    if (moved.has(index)) return
    order.push(index)
    const ids = (parsed[index] ?? []).map((call) => call.id)
    const at = (result: number) => ids.indexOf(history[result]?.message.tool_call_id ?? "")
    order.push(...(results.get(index) ?? []).sort((a, b) => at(a) - at(b)))
  })
  return order
}

// Runtime section 4: a side's own turns are assistant turns, the other side's are user turns, and the other
// side's tool calls stay hidden. History before the message that started the turn is past history, which
// includeChat and includePastTools admit. A call and its result are shown or hidden together.
export const toProviderMessages = (history: ReadonlyArray<RequestRow>, view: HistoryView): Array<ProviderMessage> => {
  const own = roleOf(view.side)
  const other = roleOf(view.side === "a" ? "b" : "a")
  const shownCalls = new Map<string, boolean>()
  const shownBySeq = new Map<number, ReadonlyArray<ProviderToolCallPart>>()
  const messages: Array<ProviderMessage> = []
  const parsed = history.map(({ message }) =>
    (message.role === "user" || message.role === "assistant") && message.tool_calls != null
      ? toolCallsOf(message)
      : NO_CALLS,
  )
  const visit = ({ message, seq, callerSeq }: RequestRow, index: number) => {
    const past = view.past.has(message.id)
    if (message.role === "tool") {
      const visible =
        callerSeq == null
          ? shownCalls.get(message.tool_call_id ?? "")
          : shownBySeq.get(callerSeq)?.some((call) => call.id === message.tool_call_id)
      if (!visible) return
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
      for (const call of parsed[index] ?? []) shownCalls.set(call.id, false)
      if (!past || view.includeChat) messages.push({ role: "user", content: textOf(message) })
    } else if (message.role === own) {
      const calls = parsed[index] ?? []
      const showCalls = calls.length > 0 && (!past || view.includePastTools)
      if (seq !== undefined && showCalls) shownBySeq.set(seq, calls)
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
  }
  const order = requestOrder(history, parsed)
  if (order === undefined) history.forEach(visit)
  else for (const index of order) visit(history[index] as RequestRow, index)
  return messages
}

const withoutReasoning = (message: ProviderMessage): ProviderMessage => {
  if (message.role !== "assistant") return message
  const { reasoning: _reasoning, reasoningDetails: _details, ...rest } = message
  return rest
}

const buildRequest = (
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

export const assembleRequest = Effect.fnUntraced(function* (
  turn: Turn,
  view: HistoryView,
  history: History,
  { hooks, secrets }: WriteContext,
  run: Execution,
  { record, observe }: StepEvents,
) {
  // Runtime section 4 orders the seven steps of an assembly.
  const rendered = yield* renderSystemPrompt(turn, secrets)
  yield* record("assemble", "interpolate the system prompt")
  const system = yield* transformHooks(hooks, "after_system_message", [], rendered)
  yield* checkSystemPrompt(turn, system, secrets)
  yield* record("assemble", `after_system_message, ${countHooks(hooks, "after_system_message")} hooks`)
  // Runtime section 4: the snapshot is the persisted history at the moment filter_messages starts, whoever
  // wrote it. A message written later belongs to the next assembly. Nothing that could let a write in, such as
  // the trace, runs between the read and the first hook.
  const { rows } = yield* history.read
  let historyRows: ReadonlyArray<RequestRow> = rows
  if (has(hooks, "filter_messages")) {
    const snapshot = rows.map((row) => row.message)
    const filtered = yield* transformHooks(hooks, "filter_messages", [], snapshot)
    if (filtered !== snapshot) {
      const byId = new Map(rows.map((row) => [row.message.id, row]))
      historyRows = filtered.map((message) => {
        const row = byId.get(message.id)
        return row ? { message, seq: row.seq, callerSeq: row.callerSeq } : { message }
      })
    }
  }
  yield* record("assemble", `snapshot, ${rows.length} messages`)
  yield* record("assemble", `filter_messages, ${countHooks(hooks, "filter_messages")} hooks`)
  const transformed = toProviderMessages(historyRows, view)
  yield* record("assemble", `transform, ${transformed.length} provider messages`)
  const prefiltered = has(hooks, "prefilter_llm_history")
    ? (yield* transformHooks(hooks, "prefilter_llm_history", [], transformed.map(toLLMMessage))).map(fromLLMMessage)
    : transformed
  // Messages section 1.3: a prompt that sets reasoning.include to false sends no reasoning, whatever a hook
  // put back.
  const messages = view.includeReasoning ? prefiltered : prefiltered.map(withoutReasoning)
  yield* checkSystemMessages(messages, secrets)
  yield* record("assemble", `prefilter_llm_history, ${countHooks(hooks, "prefilter_llm_history")} hooks`)
  const beforeRequest = run.stopAtBoundary()
  if (beforeRequest) return undefined
  yield* checkSystemPrompt(turn, system, secrets)
  const request = buildRequest(turn, system, messages, run.signal)
  yield* record("assemble", `dispatch, ${request.messages.length} messages, ${request.tools?.length ?? 0} tools`)
  yield* observe({ type: "request", request })
  return request
})
