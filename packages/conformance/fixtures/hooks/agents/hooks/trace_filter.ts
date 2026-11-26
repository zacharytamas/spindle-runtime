import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "filter_messages",
  id: "trace_filter",
  execute: async (_state, messages) => {
    console.log(`[hook] filter_messages ${JSON.stringify(messages.map((m) => m.content))}`)
    return messages
  },
})
