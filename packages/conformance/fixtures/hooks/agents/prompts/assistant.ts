import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "assistant",
  toolDescription: "A test assistant whose request hooks print what they see",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: ["note"],
  includeChat: true,
  hooks: ["trace_system", "trace_filter", "trace_prefilter"],
})
