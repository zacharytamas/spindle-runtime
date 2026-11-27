import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_tool_call_failure",
  id: "noop_failure",
  execute: async () => {
    return null
  },
})
