import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "assistant",
  env: { SPINDLE_TEST_API_KEY: "fixture-default-key" },
  sideA: { prompt: "assistant" },
  sideB: { human: true },
})
