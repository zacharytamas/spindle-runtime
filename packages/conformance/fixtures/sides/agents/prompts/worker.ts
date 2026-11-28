import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "worker",
  toolDescription: "Side A worker prompt",
  model: "lane",
  prompt: "You are side A.",
  includeChat: true,
})
