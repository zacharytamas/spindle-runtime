import {
  type LLMProviderInterface,
  ProviderError,
  type ProviderErrorCode,
  type ProviderReasoningDetail,
  type ProviderResponse,
  type ProviderStreamChunk,
  type ProviderToolCallPart,
} from "@standardagents/spec"
import { Schema } from "effect"

const Call = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
})

const Response = Schema.Struct({
  text: Schema.optionalKey(Schema.NullOr(Schema.String)),
  reasoning: Schema.optionalKey(Schema.String),
  toolCalls: Schema.optionalKey(Schema.Array(Call)),
  chunks: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  error: Schema.optionalKey(
    Schema.Struct({
      message: Schema.String,
      code: Schema.optionalKey(
        Schema.Literals(["rate_limit", "invalid_request", "auth_error", "server_error", "timeout", "unknown"]),
      ),
      statusCode: Schema.optionalKey(Schema.Number),
      retryAfter: Schema.optionalKey(Schema.Number),
    }),
  ),
})

// A script lists the model's responses in order. With repeat, the last response answers every later request.
export const Script = Schema.Struct({ responses: Schema.Array(Response), repeat: Schema.optionalKey(Schema.Boolean) })
export type Script = typeof Script.Type

export const decodeScript = Schema.decodeUnknownEffect(Schema.fromJsonString(Script))

const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

const CODES: ReadonlyArray<string> = [
  "rate_limit",
  "invalid_request",
  "auth_error",
  "server_error",
  "timeout",
  "unknown",
]

const failure = (message: string, code: string | undefined) =>
  new ProviderError(
    message,
    CODES.includes(code ?? "") ? (code as ProviderErrorCode) : "unknown",
    undefined,
    undefined,
    {
      origin: "provider:script",
    },
  )

export const scriptedProvider = (script: Script): LLMProviderInterface => {
  let index = 0
  let calls = 0
  const next = () => {
    const response = script.responses[index] ?? (script.repeat === true ? script.responses.at(-1) : undefined)
    index += 1
    if (response === undefined)
      throw new ProviderError(`The script has no response left for request ${index}`, "invalid_request")
    if (response.error !== undefined)
      throw new ProviderError(
        response.error.message,
        response.error.code ?? "unknown",
        response.error.statusCode,
        response.error.retryAfter,
        { origin: "provider:script" },
      )
    if (response.chunks !== undefined) return response.chunks as ReadonlyArray<ProviderStreamChunk>
    const chunks: Array<ProviderStreamChunk> = []
    if (response.reasoning !== undefined) chunks.push({ type: "reasoning-delta", delta: response.reasoning })
    if (typeof response.text === "string") chunks.push({ type: "content-delta", delta: response.text })
    for (const call of response.toolCalls ?? []) {
      calls += 1
      const id = call.id ?? `call_${calls}`
      chunks.push({ type: "tool-call-start", id, name: call.name })
      chunks.push({ type: "tool-call-delta", id, argumentsDelta: JSON.stringify(call.arguments) })
      chunks.push({ type: "tool-call-done", id, arguments: { ...call.arguments } })
    }
    const finishReason = (response.toolCalls ?? []).length > 0 ? "tool_calls" : "stop"
    chunks.push({ type: "finish", finishReason, usage })
    return chunks
  }
  return {
    name: "script",
    specificationVersion: "1",
    stream: async () => {
      const chunks = next()
      return (async function* () {
        yield* chunks
      })()
    },
    generate: async () => {
      let content: string | null = null
      let reasoning: string | undefined
      let details: Array<ProviderReasoningDetail> | undefined
      let finishReason: ProviderResponse["finishReason"] | undefined
      const toolCalls = new Map<string, ProviderToolCallPart>()
      for (const chunk of next()) {
        if (chunk.type === "content-delta") content = (content ?? "") + chunk.delta
        else if (chunk.type === "reasoning-delta") reasoning = (reasoning ?? "") + chunk.delta
        else if (chunk.type === "tool-call-start")
          toolCalls.set(chunk.id, { id: chunk.id, name: chunk.name, arguments: {} })
        else if (chunk.type === "tool-call-done") {
          const call = toolCalls.get(chunk.id)
          if (call !== undefined) call.arguments = chunk.arguments
        } else if (chunk.type === "finish") {
          finishReason = chunk.finishReason
          details = chunk.reasoningDetails
        } else if (chunk.type === "error") throw failure(chunk.error, chunk.code)
      }
      if (finishReason === undefined) throw failure("The script's response has no finish chunk", "server_error")
      return {
        content,
        ...(reasoning === undefined ? {} : { reasoning }),
        ...(details === undefined ? {} : { reasoningDetails: details }),
        ...(toolCalls.size === 0 ? {} : { toolCalls: [...toolCalls.values()] }),
        finishReason,
        usage,
      }
    },
  }
}
