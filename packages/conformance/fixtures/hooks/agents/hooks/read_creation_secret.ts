import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_thread_created",
  id: "read_creation_secret",
  execute: async (state) => {
    await state.instanceEnv("SPINDLE_CREATION_SECRET")
  },
})
