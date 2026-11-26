import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_thread_created",
  id: "seed_three",
  execute: async (state) => {
    for (const content of ["old one", "old two", "old three"]) await state.injectMessage({ role: "user", content })
  },
})
