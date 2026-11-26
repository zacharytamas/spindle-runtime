import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "injector",
  sideA: { prompt: "injector" },
  sideB: { human: true },
})
