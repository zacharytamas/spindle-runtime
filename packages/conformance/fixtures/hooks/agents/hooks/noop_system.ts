import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_system_message",
  id: "noop_system",
  execute: async () => {
    return null
  },
})
