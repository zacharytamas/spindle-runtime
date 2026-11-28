import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "relay",
  sideA: { handler: "gated_handler" },
  sideB: { human: true },
})
