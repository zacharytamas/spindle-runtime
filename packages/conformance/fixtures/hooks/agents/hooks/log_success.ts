import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_tool_call_success",
  id: "log_success",
  execute: async (_state, toolCall) => {
    console.log(`[hook] after_tool_call_success ${toolCall.id}`)
    return null
  },
})
