import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_thread_created",
  id: "log_created",
  execute: async (state) => {
    console.log(
      `[hook] after_thread_created ${state.threadId} execution=${state.execution === null ? "null" : "present"}`,
    )
  },
})
