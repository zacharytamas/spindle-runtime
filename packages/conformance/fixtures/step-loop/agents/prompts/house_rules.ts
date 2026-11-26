import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "house_rules",
  toolDescription: "Rules every prompt shares",
  model: "lane",
  prompt: [
    { type: "text", content: "House rules: be brief. " },
    { type: "include", prompt: "signature" },
  ],
  tools: ["explode"],
  env: { tone: "house-rules-default" },
})
