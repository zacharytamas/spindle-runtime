import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "assistant",
  toolDescription: "Answers from the gate's rules",
  model: "gated",
  prompt: "You are a test assistant.",
  tools: ["hold", "echo", "late"],
  includeChat: true,
  includePastTools: true,
})
