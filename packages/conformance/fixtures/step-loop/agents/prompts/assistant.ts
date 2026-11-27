import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "assistant",
  toolDescription: "A test assistant with note tools",
  model: "lane",
  prompt: "You are a test assistant. Use the tools when the user asks you to.",
  tools: ["write_note", "read_note", "explode", "nap", "finish", "strict"],
  includeChat: true,
})
