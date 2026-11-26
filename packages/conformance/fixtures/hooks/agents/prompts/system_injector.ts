import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "system_injector",
  toolDescription: "Injects from after_system_message",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: [],
  includeChat: true,
  hooks: ["inject_in_system", "trace_filter"],
})
