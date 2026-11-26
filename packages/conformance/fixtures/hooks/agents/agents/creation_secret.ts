import { defineAgent } from "@standardagents/spec"

export default defineAgent({
  name: "creation_secret",
  sideA: { prompt: "plain" },
  sideB: { human: true },
  hooks: ["read_creation_secret"],
})
