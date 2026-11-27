import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "stuck",
  sideA: { prompt: "stuck" },
  sideB: { human: true },
})
