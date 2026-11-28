import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "reviewer",
  toolDescription: "Side B reviewer prompt",
  model: "lane",
  prompt: "You are side B.",
  includeChat: true,
})
