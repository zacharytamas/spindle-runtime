import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "failing_writes",
  toolDescription: "Writes past failing hooks",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: ["try_writes"],
  includeChat: true,
  hooks: ["veto_marked", "after_boom_marked"],
})
