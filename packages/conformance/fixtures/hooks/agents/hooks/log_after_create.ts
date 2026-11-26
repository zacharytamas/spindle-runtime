import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_create_message",
  id: "log_after_create",
  execute: async (state, message) => {
    console.log(`[hook] after_create_message ${message.id} readable=${(await state.getMessage(message.id)) !== null}`)
  },
})
