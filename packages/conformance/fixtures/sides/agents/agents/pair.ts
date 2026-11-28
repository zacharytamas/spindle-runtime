import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "pair",
  maxSessionTurns: 2,
  env: { SPINDLE_TEST_API_KEY: "fixture-default-key" },
  sideA: { prompt: "worker" },
  sideB: { prompt: "reviewer" },
})
