const provider = () => {
  throw new Error("The @scope/pkg fixture does not call a provider")
}

export const agents = {
  agent: async () => ({
    name: "agent",
    exposeAsTool: true,
    toolDescription: "The entry agent of @scope/pkg",
    sideA: { prompt: "agent" },
    sideB: { human: true },
  }),
}

export const handlers = {}

export const prompts = {
  agent: async () => ({
    name: "agent",
    toolDescription: "The prompt of the @scope/pkg entry agent",
    model: "fast",
    prompt: "Answer with the result of lookup.",
    tools: ["lookup"],
  }),
}

export const tools = {
  lookup: async () => ({
    description: "An internal tool of @scope/pkg",
    args: null,
    execute: async () => ({ status: "success", result: "@scope/pkg result" }),
  }),
}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {}

export const effects = {}

export const __meta = {
  packageId: "@scope/pkg",
  version: "1.0.0",
  entryAgents: ["agent"],
  packedAt: 1764028800000,
}
