import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "marathon",
  sideA: { prompt: "assistant", stopOnResponse: false, maxSteps: 3 },
  sideB: { human: true },
})
