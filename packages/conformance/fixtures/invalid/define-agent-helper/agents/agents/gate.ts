import { defineAgent } from "../../../../../../runtime/node_modules/@standardagents/spec/dist/index.js"

export default defineAgent({
  name: "gate",
  sideA: { human: true },
  sideB: { human: true },
  maxSessionTurns: -1,
})
