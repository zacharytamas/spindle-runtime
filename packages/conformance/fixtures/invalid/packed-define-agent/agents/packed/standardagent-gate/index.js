import { defineAgent } from "../../../../../../../runtime/node_modules/@standardagents/spec/dist/index.js"

export const agents = {
  gate: async () =>
    defineAgent({
      name: "gate",
      sideA: { human: true },
      sideB: { human: true },
      maxSessionTurns: -1,
    }),
}

export const handlers = {}
export const prompts = {}
export const tools = {}
export const models = {}
export const hooks = {}

export const __meta = {
  packageId: "standardagent-gate",
  version: "1.0.0",
  entryAgents: [],
  packedAt: 1764028800000,
}
