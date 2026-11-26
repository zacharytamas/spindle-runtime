import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_tool_call_success",
  id: "noop_success",
  execute: async () => {
    return null
  },
})
