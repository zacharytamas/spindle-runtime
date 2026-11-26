import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "trimmer",
  sideA: { prompt: "trimmer" },
  sideB: { human: true },
  hooks: ["seed_three"],
})
