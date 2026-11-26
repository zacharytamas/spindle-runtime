import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "filter_injector",
  sideA: { prompt: "filter_injector" },
  sideB: { human: true },
})
