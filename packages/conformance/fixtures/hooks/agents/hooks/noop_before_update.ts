import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "before_update_message",
  id: "noop_before_update",
  execute: async (_state, _id, updates) => {
    return updates
  },
})
