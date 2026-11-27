import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "quiet",
  toolDescription: "Answers without calling tools",
  model: "lane",
  prompt: "You are a test assistant. Answer in one sentence.",
  tools: ["write_note", "read_note"],
  toolChoice: "none",
})
