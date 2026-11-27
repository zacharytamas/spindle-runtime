import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "before_create_message",
  id: "noop_before_create",
  execute: async (_state, message) => {
    return message
  },
})
