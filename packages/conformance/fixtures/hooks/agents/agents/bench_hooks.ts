import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "bench_hooks",
  sideA: { prompt: "bench_hooks", stopOnResponse: false, maxSteps: 200 },
  sideB: { human: true },
})
