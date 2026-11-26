import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "bench",
  toolDescription: "Calls a tool that returns at once",
  model: "lane",
  prompt: "Call noop.",
  tools: ["noop"],
})
