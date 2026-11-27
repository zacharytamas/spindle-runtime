import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "assistant",
  sideA: { prompt: "assistant" },
  sideB: { human: true },
})
