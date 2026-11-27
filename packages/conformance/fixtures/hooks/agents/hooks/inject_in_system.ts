import { defineHook } from "@standardagents/spec"

let injected = false

export default defineHook({
  hook: "after_system_message",
  id: "inject_in_system",
  execute: async (state) => {
    if (!injected) {
      injected = true
      const message = await state.injectMessage({ role: "user", content: "from system hook", silent: true })
      console.log(`[hook] inject_in_system injected ${message.id}`)
    }
    return null
  },
})
