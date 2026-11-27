import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "keyed",
  toolDescription: "Interpolates a credential that it declares as text",
  model: "lane",
  prompt: [
    { type: "text", content: "Key: " },
    { type: "env", property: "SPINDLE_TEST_API_KEY" },
  ],
  variables: [{ name: "SPINDLE_TEST_API_KEY", type: "text", required: true, description: "Declared as text" }],
})
