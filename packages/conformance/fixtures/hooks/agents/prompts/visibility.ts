import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "visibility",
  toolDescription: "Shows its history",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: ["show_history"],
  includeChat: true,
})
