import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "stuck",
  toolDescription: "Waits on a hook that never settles",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: [],
  includeChat: true,
  hooks: ["never_settles"],
})
