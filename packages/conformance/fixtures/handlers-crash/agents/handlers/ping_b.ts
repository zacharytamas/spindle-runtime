import { defineHandler } from "@standardagents/spec"

export default defineHandler({
  description: "Side B handler for CLI handler x handler test",
  execute: async (state, message) => {
    await state.injectMessage({ role: "user", content: `b:${message.content ?? ""}` })
  },
})
