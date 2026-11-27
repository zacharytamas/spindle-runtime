import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "before_create_message",
  id: "log_before_create",
  execute: async (state, message) => {
    console.log(
      `[hook] before_create_message ${message.role} ${message.id} execution=${state.execution === null ? "null" : "present"}`,
    )
    return message
  },
})
