import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "composed",
  sideA: { prompt: "composed" },
  sideB: { human: true },
  env: { tone: "warm" },
})
