import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "tool_call_done",
  id: "noop_done",
  execute: async (state) => {
    void state
  },
})
