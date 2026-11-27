import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "leaky",
  sideA: { prompt: "leaky" },
  sideB: { human: true },
})
