import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "resting",
  sideA: { prompt: "resting" },
  sideB: { human: true },
  hooks: ["log_created", "log_before_create", "log_after_create"],
})
