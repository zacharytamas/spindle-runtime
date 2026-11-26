import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "shaded",
  sideA: { prompt: "shaded" },
  sideB: { human: true },
})
