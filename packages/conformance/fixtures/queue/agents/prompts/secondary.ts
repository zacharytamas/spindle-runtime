import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "secondary",
  toolDescription: "Secondary agent prompt for runAgent tests",
  model: "gated",
  prompt: "You are a secondary test assistant.",
  tools: ["hold", "echo"],
  includeChat: true,
  includePastTools: true,
})
