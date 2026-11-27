import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "filter_messages",
  id: "noop_filter",
  execute: async (_state, messages) => {
    return messages
  },
})
