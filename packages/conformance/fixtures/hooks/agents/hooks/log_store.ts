import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "before_store_tool_result",
  id: "log_store",
  execute: async (_state, toolCall, result) => {
    console.log(`[hook] before_store_tool_result ${toolCall.id} ${result.status}`)
    return result
  },
})
