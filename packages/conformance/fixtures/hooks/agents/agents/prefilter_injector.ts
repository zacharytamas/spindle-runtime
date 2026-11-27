import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "prefilter_injector",
  sideA: { prompt: "prefilter_injector" },
  sideB: { human: true },
})
