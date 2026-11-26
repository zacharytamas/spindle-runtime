import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_system_message",
  id: "trace_system",
  execute: async () => {
    console.log("[hook] after_system_message")
    return null
  },
})
