import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "keyed",
  sideA: { prompt: "keyed" },
  sideB: { human: true },
})
