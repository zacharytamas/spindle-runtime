import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "shaded",
  toolDescription: "Gives a declared variable a public default that the instance environment overrides elsewhere",
  model: "lane",
  prompt: [
    { type: "text", content: "Region: " },
    { type: "env", property: "REGION_HINT" },
  ],
  variables: [{ name: "REGION_HINT", type: "text", required: true, description: "A public region hint" }],
  env: { REGION_HINT: "public-region" },
  tools: ["recite"],
})
