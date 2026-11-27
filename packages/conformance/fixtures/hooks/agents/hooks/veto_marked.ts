import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "before_create_message",
  id: "veto_marked",
  execute: async (_state, message) => {
    if (message.content === "veto me") throw new Error("vetoed on purpose")
    return message
  },
})
