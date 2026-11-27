import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "prefilter_injector",
  toolDescription: "Injects from prefilter_llm_history",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: ["note"],
  includeChat: true,
  hooks: ["trace_filter", "inject_in_prefilter"],
})
