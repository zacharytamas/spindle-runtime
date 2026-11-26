import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "quiet",
  sideA: { prompt: "quiet" },
  sideB: { human: true },
})
