import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_create_message",
  id: "after_boom_marked",
  execute: async (_state, message) => {
    if (message.content === "after boom") throw new Error("after hook failed on purpose")
  },
})
