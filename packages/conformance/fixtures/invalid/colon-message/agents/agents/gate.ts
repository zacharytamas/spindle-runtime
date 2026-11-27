import { defineAgent } from "@standardagents/spec"

// defineAgent throws one "<path>: <message>" line per issue, so each line is reported at its field.
export default defineAgent({
  name: "gate",
  sideA: { human: true },
  sideB: { human: true },
  maxSessionTurns: -1,
})
