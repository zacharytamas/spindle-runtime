import { runInNewContext } from "node:vm"

const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export const agents = {}
export const handlers = {}
export const prompts = {}
export const hooks = {}

export const tools = {
  lookup: () =>
    runInNewContext("Promise.resolve(definition)", {
      definition: {
        description: "A tool whose loader returns a Promise from another realm",
        execute: async () => ({ status: "success", result: "" }),
      },
    }),
}

export const models = {
  inherited: async () => Object.create({ name: "inherited", provider, model: "fixture-model" }),
}

export const __meta = {
  packageId: "standardagent-other-realm",
  version: "1.0.0",
  entryAgents: [],
  packedAt: 1764028800000,
}
