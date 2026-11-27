import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_thread_created",
  id: "seed_two",
  execute: async (state) => {
    await state.injectMessage({ role: "user", content: "visible note" })
    await state.injectMessage({ role: "user", content: "silent note", silent: true })
  },
})
