import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "tool_call_started",
  id: "log_started",
  execute: async (_state, toolCall) => {
    console.log(`[hook] tool_call_started ${toolCall.id} ${toolCall.function.name}`)
  },
})
