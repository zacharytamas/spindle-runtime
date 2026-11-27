import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "bench",
  sideA: { prompt: "bench", stopOnResponse: false, maxSteps: 200 },
  sideB: { human: true },
})
