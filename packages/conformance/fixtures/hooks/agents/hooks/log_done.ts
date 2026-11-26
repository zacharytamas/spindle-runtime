import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "tool_call_done",
  id: "log_done",
  execute: async (_state, toolCall, result) => {
    console.log(`[hook] tool_call_done ${toolCall.id} ${result.status}`)
  },
})
