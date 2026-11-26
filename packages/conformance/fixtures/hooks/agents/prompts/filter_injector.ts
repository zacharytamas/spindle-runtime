import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "filter_injector",
  toolDescription: "Injects from filter_messages",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: ["note"],
  includeChat: true,
  hooks: ["inject_in_filter", "trace_filter"],
})
