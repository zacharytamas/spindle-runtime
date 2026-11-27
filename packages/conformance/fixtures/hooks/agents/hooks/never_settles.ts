import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "filter_messages",
  id: "never_settles",
  execute: (_state, messages) => {
    console.log(`[hook] never_settles got ${messages.length} messages`)
    return new Promise(() => {})
  },
})
