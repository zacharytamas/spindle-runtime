import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "tool_call_started",
  id: "noop_started",
  execute: async (state) => {
    void state
  },
})
