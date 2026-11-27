const provider = () => {
  throw new Error("The packed-a fixture does not call a provider")
}

export const agents = {
  researcher: async () => ({
    name: "researcher",
    exposeAsTool: true,
    toolDescription: "The entry agent of packed-a",
    sideA: { prompt: "researcher" },
    sideB: { human: true },
  }),
}

export const handlers = {}

export const prompts = {
  researcher: async () => ({
    name: "researcher",
    toolDescription: "The prompt of the packed-a entry agent",
    model: "fast",
    prompt: "Answer with the result of search.",
    tools: ["search"],
  }),
}

export const tools = {
  search: async () => ({
    description: "An internal tool of packed-a",
    args: null,
    execute: async () => ({ status: "success", result: "packed-a result" }),
  }),
}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {}

export const effects = {}

export const __meta = {
  packageId: "packed-a",
  version: "1.0.0",
  entryAgents: ["researcher"],
  packedAt: 1764028800000,
}
