import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "tool_logger",
  sideA: { prompt: "tool_logger" },
  sideB: { human: true },
})
