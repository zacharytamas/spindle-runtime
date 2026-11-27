import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_thread_created",
  id: "noop_created",
  execute: async (state) => {
    void state
  },
})
