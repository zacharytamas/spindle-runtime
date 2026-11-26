import { defineHook } from "@standardagents/spec"

let injected = false

export default defineHook({
  hook: "prefilter_llm_history",
  id: "inject_in_prefilter",
  execute: async (state, messages) => {
    console.log(`[hook] prefilter_llm_history ${JSON.stringify(messages.map((m) => m.content))}`)
    if (!injected) {
      injected = true
      const message = await state.injectMessage({ role: "user", content: "from prefilter" })
      console.log(`[hook] inject_in_prefilter injected ${message.id}`)
    }
    return messages
  },
})
