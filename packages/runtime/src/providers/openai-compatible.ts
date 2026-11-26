import {
  type ContentPart,
  type FetchLike,
  type LLMProviderInterface,
  mapReasoningLevel,
  type ProviderConfigSlots,
  ProviderError,
  type ProviderErrorCode,
  type ProviderFactoryConfig,
  type ProviderFactoryWithOptions,
  type ProviderFinishReason,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamChunk,
  type ProviderToolCallPart,
  type ProviderToolResultContent,
  type ProviderUsage,
} from "@standardagents/spec"

const NAME = "openai_compatible"
const ORIGIN = `provider:${NAME}` as const

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)

const dataUri = (mediaType: string, data: string) =>
  data.startsWith("data:") ? data : `data:${mediaType};base64,${data}`

const nativeContent = (content: string | ReadonlyArray<ContentPart>) =>
  typeof content === "string"
    ? content
    : content.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text }
        if (part.type === "image")
          return { type: "image_url", image_url: { url: dataUri(part.mediaType, part.data), detail: part.detail } }
        if (part.type === "image_url") return { type: "image_url", image_url: part.image_url }
        return { type: "file", file: { filename: part.filename, file_data: dataUri(part.mediaType, part.data) } }
      })

const toolResultText = (content: ProviderToolResultContent): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content.map((part) => (part.type === "text" ? part.text : `[${part.type} content]`)).join("\n")
  return content.type === "text" ? content.text : content.error
}

const nativeMessage = (message: ProviderMessage): Json => {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content }
    case "user":
      return { role: "user", content: nativeContent(message.content) }
    case "assistant": {
      const calls = message.toolCalls ?? []
      // Chat completions has no field for reasoning on an earlier turn, so this provider does not send it.
      return calls.length === 0
        ? { role: "assistant", content: message.content ?? "" }
        : {
            role: "assistant",
            content: message.content ?? null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
    }
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: toolResultText(message.content) }
  }
}

const reasoningEffort = (request: ProviderRequest): { readonly set: boolean; readonly value?: string } => {
  const level = request.reasoning?.level
  if (level === undefined) return { set: false }
  const levels = request.reasoning?.levels
  if (levels === undefined || Object.keys(levels).length === 0) return { set: false }
  const mapped = mapReasoningLevel(level, levels)
  return mapped === null ? { set: true } : { set: true, value: mapped }
}

export const requestBody = (request: ProviderRequest, stream: boolean): Json => {
  const tools = request.tools ?? []
  const body: Json = { ...request.providerOptions, model: request.model, messages: request.messages.map(nativeMessage) }
  if (tools.length > 0) {
    body.tools = tools.map((tool) => ({ type: "function", function: tool.function }))
    if (request.toolChoice !== undefined)
      body.tool_choice =
        typeof request.toolChoice === "string"
          ? request.toolChoice
          : { type: "function", function: { name: request.toolChoice.name } }
    if (request.parallelToolCalls !== undefined) body.parallel_tool_calls = request.parallelToolCalls
  }
  if (request.maxOutputTokens !== undefined) body.max_tokens = request.maxOutputTokens
  if (request.temperature !== undefined) body.temperature = request.temperature
  if (request.topP !== undefined) body.top_p = request.topP
  if (request.stopSequences !== undefined) body.stop = request.stopSequences
  if (request.responseFormat?.type === "json")
    body.response_format =
      request.responseFormat.schema === undefined
        ? { type: "json_object" }
        : { type: "json_schema", json_schema: { name: "response", schema: request.responseFormat.schema } }
  const effort = reasoningEffort(request)
  if (effort.set) {
    delete body.reasoning_effort
    if (effort.value !== undefined) body.reasoning_effort = effort.value
  }
  if (stream) {
    body.stream = true
    body.stream_options = { include_usage: true }
  }
  return body
}

const codeForStatus = (status: number): ProviderErrorCode => {
  if (status === 429) return "rate_limit"
  if (status === 401 || status === 403) return "auth_error"
  if (status === 400 || status === 404 || status === 422) return "invalid_request"
  if (status >= 500) return "server_error"
  return "unknown"
}

const retryAfterSeconds = (response: Response): number | undefined => {
  const header = response.headers.get("retry-after")
  if (header === null) return undefined
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined
}

const httpError = async (response: Response): Promise<ProviderError> => {
  const text = await response.text().catch(() => "")
  let detail = text.slice(0, 500)
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed) && isRecord(parsed.error) && typeof parsed.error.message === "string")
      detail = parsed.error.message
  } catch {}
  return new ProviderError(
    `The endpoint answered ${response.status}${detail === "" ? "" : `: ${detail}`}`,
    codeForStatus(response.status),
    response.status,
    retryAfterSeconds(response),
    { origin: ORIGIN },
  )
}

const transportError = (cause: unknown, timedOut: boolean): ProviderError =>
  timedOut
    ? new ProviderError("The request to the endpoint timed out", "timeout", undefined, undefined, {
        cause,
        origin: ORIGIN,
      })
    : new ProviderError(
        `The request to the endpoint failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        "unknown",
        undefined,
        undefined,
        { cause, origin: ORIGIN },
      )

const finishReason = (value: unknown): ProviderFinishReason => {
  switch (value) {
    case "length":
      return "length"
    case "tool_calls":
    case "function_call":
      return "tool_calls"
    case "content_filter":
      return "content_filter"
    case "error":
      return "error"
    default:
      return "stop"
  }
}

const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0)

const usageOf = (value: unknown): ProviderUsage => {
  const usage = isRecord(value) ? value : {}
  const result: ProviderUsage = {
    promptTokens: count(usage.prompt_tokens),
    completionTokens: count(usage.completion_tokens),
    totalTokens: count(usage.total_tokens),
  }
  const completion = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : {}
  const prompt = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {}
  if (typeof completion.reasoning_tokens === "number") result.reasoningTokens = completion.reasoning_tokens
  if (typeof prompt.cached_tokens === "number") result.cachedTokens = prompt.cached_tokens
  if (typeof usage.cost === "number") result.cost = usage.cost
  return result
}

const parseArguments = (text: string): Json | undefined => {
  try {
    const parsed: unknown = JSON.parse(text === "" ? "{}" : text)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const reasoningText = (delta: Json): string | undefined => {
  if (typeof delta.reasoning_content === "string") return delta.reasoning_content
  if (typeof delta.reasoning === "string") return delta.reasoning
  return undefined
}

async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true })
    let end = buffer.indexOf("\n")
    while (end !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, "")
      buffer = buffer.slice(end + 1)
      if (line.startsWith("data:")) yield line.slice(5).trimStart()
      end = buffer.indexOf("\n")
    }
  }
  buffer += decoder.decode()
  if (buffer.startsWith("data:")) yield buffer.slice(5).trimStart()
}

interface WireCall {
  id: string
  name: string
  arguments: string
}

// A call whose argument text is not a JSON object gets no tool-call-done, so the runtime never runs it.
async function* streamChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<ProviderStreamChunk> {
  const calls = new Map<number, WireCall>()
  let finish: unknown
  let usage: unknown
  let sawContent = false
  let sawReasoning = false
  for await (const data of serverSentEvents(body)) {
    if (data === "[DONE]") break
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      yield { type: "error", error: `The endpoint sent an event that is not JSON: ${data.slice(0, 200)}` }
      return
    }
    if (!isRecord(event)) continue
    if (isRecord(event.error)) {
      yield {
        type: "error",
        error: typeof event.error.message === "string" ? event.error.message : JSON.stringify(event.error),
        ...(typeof event.error.code === "string" ? { code: event.error.code } : {}),
      }
      return
    }
    if (event.usage !== undefined && event.usage !== null) usage = event.usage
    const choice = Array.isArray(event.choices) && isRecord(event.choices[0]) ? event.choices[0] : undefined
    if (choice === undefined) continue
    const delta = isRecord(choice.delta) ? choice.delta : {}
    const reasoning = reasoningText(delta)
    if (reasoning !== undefined && reasoning !== "") {
      sawReasoning = true
      yield { type: "reasoning-delta", delta: reasoning }
    }
    if (typeof delta.content === "string" && delta.content !== "") {
      sawContent = true
      yield { type: "content-delta", delta: delta.content }
    }
    if (Array.isArray(delta.tool_calls))
      for (const part of delta.tool_calls) {
        if (!isRecord(part)) continue
        const index = typeof part.index === "number" ? part.index : calls.size
        const fn = isRecord(part.function) ? part.function : {}
        let call = calls.get(index)
        if (call === undefined) {
          call = { id: typeof part.id === "string" ? part.id : `call_${index}`, name: "", arguments: "" }
          calls.set(index, call)
        }
        if (call.name === "" && typeof fn.name === "string" && fn.name !== "") {
          call.name = fn.name
          yield { type: "tool-call-start", id: call.id, name: call.name }
        }
        if (typeof fn.arguments === "string" && fn.arguments !== "") {
          call.arguments += fn.arguments
          yield { type: "tool-call-delta", id: call.id, argumentsDelta: fn.arguments }
        }
      }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finish = choice.finish_reason
  }
  if (sawReasoning) yield { type: "reasoning-done" }
  if (sawContent) yield { type: "content-done" }
  for (const call of calls.values()) {
    const parsed = parseArguments(call.arguments)
    if (parsed !== undefined) yield { type: "tool-call-done", id: call.id, arguments: parsed }
  }
  yield { type: "finish", finishReason: finishReason(finish), usage: usageOf(usage) }
}

const responseOf = (body: unknown): ProviderResponse => {
  const choice = isRecord(body) && Array.isArray(body.choices) && isRecord(body.choices[0]) ? body.choices[0] : {}
  const message = isRecord(choice.message) ? choice.message : {}
  const toolCalls: Array<ProviderToolCallPart> = []
  for (const part of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(part) || !isRecord(part.function)) continue
    const text = typeof part.function.arguments === "string" ? part.function.arguments : ""
    const parsed = parseArguments(text)
    if (parsed === undefined)
      throw new ProviderError(
        `The model returned arguments for ${String(part.function.name)} that are not a JSON object`,
        "unknown",
        undefined,
        undefined,
        { origin: ORIGIN },
      )
    toolCalls.push({ id: String(part.id), name: String(part.function.name), arguments: parsed })
  }
  const reasoning = reasoningText(message)
  return {
    content: typeof message.content === "string" ? message.content : null,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    finishReason: finishReason(choice.finish_reason),
    usage: usageOf(isRecord(body) ? body.usage : undefined),
    ...(isRecord(body) && typeof body.id === "string" ? { metadata: { requestId: body.id } } : {}),
  }
}

export const openaiCompatible: ProviderFactoryWithOptions = Object.assign(
  (config: ProviderFactoryConfig): LLMProviderInterface => {
    const send: FetchLike = config.fetch ?? ((input, init) => fetch(input, init))
    const baseUrl = (typeof config.baseUrl === "string" ? config.baseUrl : "https://api.openai.com/v1").replace(
      /\/+$/,
      "",
    )
    const post = async (request: ProviderRequest, stream: boolean): Promise<Response> => {
      const headers: Record<string, string> = { ...config.defaultHeaders, "content-type": "application/json" }
      if (config.apiKey !== "") headers.authorization = `Bearer ${config.apiKey}`
      const timeout = typeof config.timeout === "number" ? AbortSignal.timeout(config.timeout) : undefined
      const signals = [request.signal, timeout].filter((signal) => signal !== undefined)
      const signal = signals.length === 0 ? undefined : AbortSignal.any(signals)
      let response: Response
      try {
        response = await send(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody(request, stream)),
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (cause) {
        throw transportError(cause, timeout?.aborted === true && request.signal?.aborted !== true)
      }
      if (!response.ok) throw await httpError(response)
      return response
    }
    return {
      name: NAME,
      specificationVersion: "1",
      generate: async (request) => responseOf(await (await post(request, false)).json()),
      stream: async (request) => {
        const response = await post(request, true)
        if (response.body === null)
          throw new ProviderError("The endpoint sent no response body", "server_error", response.status, undefined, {
            origin: ORIGIN,
          })
        return streamChunks(response.body)
      },
    }
  },
  {
    configSlots: {
      apiKey: {
        type: "secret",
        required: false,
        defaultEnv: "OPENAI_API_KEY",
        description: "API key sent as a bearer token. A local server may need none.",
      },
      baseUrl: {
        type: "url",
        required: false,
        default: "https://api.openai.com/v1",
        defaultEnv: "OPENAI_BASE_URL",
        description: "Base URL of the chat completions API, without /chat/completions.",
      },
      timeout: { type: "number", required: false, description: "Request timeout in milliseconds." },
    } satisfies ProviderConfigSlots,
  },
)
