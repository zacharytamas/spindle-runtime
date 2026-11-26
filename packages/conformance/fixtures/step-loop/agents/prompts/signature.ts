import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "signature",
  toolDescription: "A closing line",
  model: "lane",
  prompt: "Sign every answer as Spindle.",
})
