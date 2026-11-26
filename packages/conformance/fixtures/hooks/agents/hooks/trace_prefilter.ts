import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "prefilter_llm_history",
  id: "trace_prefilter",
  execute: async (_state, messages) => {
    console.log(`[hook] prefilter_llm_history ${messages.length} messages`)
    return messages
  },
})
