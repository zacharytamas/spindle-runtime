import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_create_message",
  id: "noop_after_create",
  execute: async (state) => {
    void state
  },
})
