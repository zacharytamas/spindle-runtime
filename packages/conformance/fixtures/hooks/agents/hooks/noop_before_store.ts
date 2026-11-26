import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "before_store_tool_result",
  id: "noop_before_store",
  execute: async (_state, _call, result) => {
    return result
  },
})
