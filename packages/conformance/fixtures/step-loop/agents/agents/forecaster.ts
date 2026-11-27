import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "forecaster",
  sideA: { prompt: "forecaster" },
  sideB: { human: true },
})
