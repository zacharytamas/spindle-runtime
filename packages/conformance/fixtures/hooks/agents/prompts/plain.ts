import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "plain",
  toolDescription: "Answers with no hooks",
  model: "lane",
  prompt: "You are a test assistant.",
})
