import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "filter_messages",
  id: "keep_last_two",
  execute: async (_state, messages) => {
    return [
      ...messages.slice(-2),
      { id: "synthetic_summary", role: "user", content: "synthetic summary", created_at: 0 },
    ]
  },
})
