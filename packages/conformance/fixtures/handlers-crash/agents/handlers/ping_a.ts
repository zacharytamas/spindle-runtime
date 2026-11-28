import { defineHandler } from "@standardagents/spec"

export default defineHandler({
  description: "Side A handler for CLI handler x handler test",
  execute: async (state, message) => {
    await state.injectMessage({ role: "assistant", content: `a:${message.content ?? ""}` })
  },
})
