import type { ContentPart, ProviderMessage, ProviderReasoningDetail, ProviderToolCallPart } from "@standardagents/spec"
import { Schema } from "effect"
import { toJson } from "../store/json.ts"

const string = Schema.String
const optionalString = Schema.optional(string)
const detail = Schema.optional(Schema.Literals(["auto", "low", "high"]))
const parts = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: string }),
  Schema.Struct({ type: Schema.Literal("image"), data: string, mediaType: string, detail }),
  Schema.Struct({ type: Schema.Literal("image_url"), image_url: Schema.Struct({ url: string, detail }) }),
  Schema.Struct({ type: Schema.Literal("file"), data: string, mediaType: string, filename: optionalString }),
])
const isPart = Schema.is(parts)
const isDetail = Schema.is(
  Schema.Struct({
    type: Schema.Literals(["text", "summary", "encrypted"]),
    id: optionalString,
    text: optionalString,
    data: optionalString,
    format: optionalString,
  }),
)
const content = Schema.Union([string, Schema.mutable(Schema.Array(Schema.declare((u): u is ContentPart => isPart(u))))])
const object = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)
const jsonRecord = Schema.declare((u): u is Record<string, unknown> => object(u) && typeof toJson(u) === "string")
const objectText = Schema.declare((u): u is string => typeof u === "string" && object(JSON.parse(u)))
const call = Schema.Struct({
  id: string,
  function: Schema.Struct({ name: string, arguments: Schema.Union([objectText, jsonRecord]) }),
  extra_content: Schema.optional(jsonRecord),
})
const tool = { role: Schema.Literal("tool"), tool_call_id: string, name: optionalString }
const message = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: string }),
  Schema.Struct({ role: Schema.Literal("user"), content }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.optional(Schema.NullOr(string)),
    tool_calls: Schema.optional(Schema.Array(call)),
    reasoning_content: optionalString,
    reasoning_details: Schema.optional(
      Schema.mutable(Schema.Array(Schema.declare((u): u is ProviderReasoningDetail => isDetail(u)))),
    ),
  }),
  Schema.Struct({ ...tool, tool_status: Schema.Literal("error"), content: string }),
  Schema.Struct({ ...tool, tool_status: Schema.optional(Schema.Literal("success")), content }),
])
export type RequestMessage = typeof message.Type
export const isRequestHistory = Schema.is(Schema.mutable(Schema.Array(message)))

// Hooks section 3.3 hands prefilter_llm_history the history in chat completion format, the shape of LLMMessage.
// A tool error keeps its kind in tool_status, the field a stored tool message uses for it.
export const toLLMMessage = (message: ProviderMessage): RequestMessage => {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content }
    case "user":
      return { role: message.role, content: message.content }
    case "assistant":
      return {
        role: "assistant",
        content: message.content ?? null,
        ...(message.toolCalls === undefined
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                ...(call.extraContent === undefined ? {} : { extra_content: call.extraContent }),
              })),
            }),
        ...(message.reasoning == null ? {} : { reasoning_content: message.reasoning }),
        ...(message.reasoningDetails === undefined ? {} : { reasoning_details: message.reasoningDetails }),
      }
    case "tool": {
      const content = message.content
      const link = { tool_call_id: message.toolCallId, name: message.toolName }
      if (typeof content === "string" || Array.isArray(content)) return { role: "tool", ...link, content }
      return content.type === "text"
        ? { role: "tool", ...link, content: content.text }
        : { role: "tool", ...link, content: content.error, tool_status: "error" }
    }
  }
}

const callFrom = (entry: typeof call.Type): ProviderToolCallPart => ({
  id: entry.id,
  name: entry.function.name,
  arguments:
    typeof entry.function.arguments === "string" ? JSON.parse(entry.function.arguments) : entry.function.arguments,
  ...(entry.extra_content === undefined ? {} : { extraContent: entry.extra_content }),
})

// The way back from LLMMessage, for the array prefilter_llm_history returns. hooks.ts has checked each message
// against the provider message types, so every field one of them holds is kept as it is. A field that no provider
// message type has, such as the name of a user message, has nowhere to go.
export const fromLLMMessage = (message: RequestMessage): ProviderMessage => {
  switch (message.role) {
    case "system":
      return { role: "system", content: message.content }
    case "user":
      return { role: "user", content: message.content }
    case "assistant":
      return {
        role: "assistant",
        content: message.content ?? null,
        ...(Array.isArray(message.tool_calls) ? { toolCalls: message.tool_calls.map(callFrom) } : {}),
        ...(message.reasoning_content === undefined ? {} : { reasoning: message.reasoning_content }),
        ...(Array.isArray(message.reasoning_details) ? { reasoningDetails: message.reasoning_details } : {}),
      }
    default:
      return {
        role: "tool",
        toolCallId: message.tool_call_id,
        toolName: message.name ?? "",
        content: message.tool_status === "error" ? { type: "error", error: message.content } : message.content,
      }
  }
}
