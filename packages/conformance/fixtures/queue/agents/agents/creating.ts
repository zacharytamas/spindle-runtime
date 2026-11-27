import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "creating",
  hooks: ["gate_created"],
  sideA: { prompt: "assistant" },
  sideB: { human: true },
})
