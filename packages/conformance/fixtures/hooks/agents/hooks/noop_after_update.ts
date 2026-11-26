import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_update_message",
  id: "noop_after_update",
  execute: async (state) => {
    void state
  },
})
