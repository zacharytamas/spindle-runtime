import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "ping_pong",
  maxSessionTurns: 3,
  sideA: { handler: "ping_a" },
  sideB: { handler: "ping_b" },
})
