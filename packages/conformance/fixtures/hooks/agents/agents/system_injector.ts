import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "system_injector",
  sideA: { prompt: "system_injector" },
  sideB: { human: true },
})
