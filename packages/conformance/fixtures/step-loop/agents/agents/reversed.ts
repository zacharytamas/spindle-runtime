import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "reversed",
  sideA: { human: true },
  sideB: { prompt: "assistant" },
})
