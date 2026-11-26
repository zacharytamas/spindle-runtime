import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "hooked",
  hooks: ["gate_store"],
  sideA: { prompt: "assistant" },
  sideB: { human: true },
})
