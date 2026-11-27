import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "failing_writes",
  sideA: { prompt: "failing_writes" },
  sideB: { human: true },
})
