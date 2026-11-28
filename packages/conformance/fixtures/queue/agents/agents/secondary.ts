import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "secondary",
  sideA: { prompt: "secondary" },
  sideB: { human: true },
})
