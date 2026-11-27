import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_tool_call_failure",
  id: "log_failure",
  execute: async (_state, toolCall) => {
    console.log(`[hook] after_tool_call_failure ${toolCall.id}`)
    return null
  },
})
