import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "stopper",
  sideA: { prompt: "assistant", stopTool: "finish", stopToolResponseProperty: "summary" },
  sideB: { human: true },
})
