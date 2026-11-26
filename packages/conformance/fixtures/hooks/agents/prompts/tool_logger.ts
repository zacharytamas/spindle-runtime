import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "tool_logger",
  toolDescription: "Logs every tool hook",
  model: "lane",
  prompt: "You are a test assistant.",
  tools: ["write_note", "explode"],
  includeChat: true,
  hooks: ["log_started", "log_success", "log_failure", "log_store", "log_done"],
})
