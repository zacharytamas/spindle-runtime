import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "resting",
  toolDescription: "Answers after an injection at rest",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: [],
  includeChat: true,
})
