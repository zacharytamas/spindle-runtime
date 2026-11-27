import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "leaky",
  toolDescription: "Calls a tool that returns secrets",
  model: "lane",
  prompt: "Call reveal.",
  tools: ["reveal"],
})
