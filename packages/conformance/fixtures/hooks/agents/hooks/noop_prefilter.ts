import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "prefilter_llm_history",
  id: "noop_prefilter",
  execute: async (_state, messages) => {
    return messages
  },
})
