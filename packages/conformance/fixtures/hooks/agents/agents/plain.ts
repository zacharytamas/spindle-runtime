import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "plain",
  sideA: { prompt: "plain" },
  sideB: { human: true },
})
