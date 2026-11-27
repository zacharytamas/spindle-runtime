import { defineHook } from "@standardagents/spec"

let injected = false

export default defineHook({
  hook: "filter_messages",
  id: "inject_in_filter",
  execute: async (state, messages) => {
    if (!injected) {
      injected = true
      const message = await state.injectMessage({ role: "user", content: "from filter" })
      console.log(`[hook] inject_in_filter injected ${message.id}`)
    }
    return messages
  },
})
