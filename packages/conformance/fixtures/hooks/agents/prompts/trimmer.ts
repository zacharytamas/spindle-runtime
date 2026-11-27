import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "trimmer",
  toolDescription: "Keeps the last two messages in its requests",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: ["show_history"],
  includeChat: true,
  hooks: ["keep_last_two"],
})
