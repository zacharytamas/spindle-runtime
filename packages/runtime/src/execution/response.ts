import type { ToolResult } from "@standardagents/spec"
import type { NewMessage } from "../store/model.ts"
import type { ModelResponse } from "./call.ts"
import { mapStrings } from "./redact.ts"
import type { StopToolOutcome } from "./step.ts"
import type { ToolCall } from "./tools.ts"
import { roleOf, type Turn } from "./turn.ts"

const parseJson = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

const preview = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}...` : text)

// Messages section 1 stores arguments as the JSON text of an object, so arguments that are not one are kept as the
// text of invalid_json.
export const argumentsOf = (call: ToolCall) => JSON.stringify(call.arguments ?? { invalid_json: call.argumentsText })

// A call is run only when the provider named it and finished its arguments as one JSON object.
export const toolCallsOf = (response: ModelResponse): Array<ToolCall> =>
  [...response.calls.values()].map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    argumentsText: call.argumentsText,
    problem:
      call.name === ""
        ? `The provider sent call ${call.id} without the name of a tool`
        : call.arguments === undefined
          ? `The model sent arguments for ${call.name} that are not a valid JSON object, so the tool did not run. It sent: ${preview(call.argumentsText)}`
          : undefined,
  }))

// Messages section 1.3: reasoning details go back only to the model that produced them, so the message records
// which model definition and native model that was. A later model under the same prompt name gets none.
export const reasoningSource = (turn: Turn) => ({
  definition: turn.model.definition.qualifiedName,
  model: turn.model.value.model,
})

// The response is stored as the model returned it, so the stored arguments are what the model sent and what the
// next request shows. The tool gets them after its schema validates them, which may transform a value.
export const responseMessage = (turn: Turn, response: ModelResponse, calls: ReadonlyArray<ToolCall>): NewMessage => {
  const extra = Object.fromEntries(
    [...response.calls.values()].flatMap((call) =>
      call.extraContent === undefined ? [] : [[call.id, call.extraContent] as const],
    ),
  )
  return {
    role: roleOf(turn.side),
    content: response.content,
    tool_calls:
      calls.length === 0
        ? null
        : JSON.stringify(
            calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: argumentsOf(call) },
            })),
          ),
    reasoning_content: response.reasoning,
    reasoning_details: response.reasoningDetails === undefined ? null : JSON.stringify(response.reasoningDetails),
    prompt: turn.prompt.definition.qualifiedName,
    status: "completed",
    metadata: {
      ...(Object.keys(extra).length === 0 ? {} : { tool_call_extra: extra }),
      ...(response.reasoningDetails === undefined ? {} : { reasoning_source: reasoningSource(turn) }),
    },
  }
}

// The runtime reads the stop property from the result before redaction, and reports the value redacted.
export const stopToolOutcome = (
  turn: Turn,
  calls: ReadonlyArray<ToolCall>,
  results: ReadonlyArray<ToolResult>,
  redact: (text: string) => string,
) => {
  const index = calls.findIndex((call) => call.name === turn.config.stopTool)
  const call = calls[index]
  const result = results[index]
  if (call === undefined || result === undefined) return undefined
  const property = turn.config.stopToolResponseProperty
  const parsed = parseJson(result.result)
  const value =
    property === undefined
      ? (result.result ?? null)
      : typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, property)
        ? (parsed as Record<string, unknown>)[property]
        : null
  return {
    tool: call.name,
    callId: call.id,
    status: result.status,
    value: mapStrings(value, redact, redact),
  } satisfies StopToolOutcome
}
