import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "visibility",
  sideA: { prompt: "visibility" },
  sideB: { human: true },
  hooks: ["seed_two"],
})
