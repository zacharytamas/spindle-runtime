import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "injector",
  toolDescription: "Injects a note from a tool",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: ["inject_note", "read_history"],
  includeChat: true,
  hooks: ["log_before_create", "log_after_create"],
})
