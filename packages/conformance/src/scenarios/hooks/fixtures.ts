import type { Message } from "@standardagents/spec"
import { type Setup, stubTool, toolResults } from "../harness.ts"

export const noop = { noop: stubTool("Does nothing", "noop") }

export const toolRows = (messages: ReadonlyArray<Message>) =>
  toolResults(messages).map((m) => [m.tool_call_id, m.tool_status, m.content])

export const hookIds = (hooks: Setup["hooks"]) => (hooks ?? []).map((hook) => hook.id)
