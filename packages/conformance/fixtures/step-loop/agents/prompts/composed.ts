import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "composed",
  toolDescription: "A prompt built from parts",
  model: "lane",
  prompt: [
    { type: "text", content: "You are a test assistant.\n\n" },
    { type: "include", prompt: "house_rules" },
    { type: "text", content: "\n\nAnswer in a " },
    { type: "env", property: "tone" },
    { type: "text", content: " tone." },
  ],
  variables: [{ name: "tone", type: "text", required: true, description: "The tone of every answer" }],
  env: { tone: "prompt-default" },
})
