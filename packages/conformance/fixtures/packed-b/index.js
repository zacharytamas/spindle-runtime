const provider = () => {
  throw new Error("The packed-b fixture does not call a provider")
}

export const agents = {
  writer: async () => ({
    name: "writer",
    exposeAsTool: true,
    toolDescription: "The entry agent of packed-b",
    sideA: { prompt: "writer" },
    sideB: { human: true },
  }),
}

export const handlers = {}

export const prompts = {
  writer: async () => ({
    name: "writer",
    toolDescription: "The prompt of the packed-b entry agent",
    model: "fast",
    prompt: "Answer with the result of search.",
    tools: ["search"],
  }),
}

export const tools = {
  search: async () => ({
    description: "An internal tool of packed-b",
    args: null,
    execute: async () => ({ status: "success", result: "packed-b result" }),
  }),
}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {}

export const effects = {}

export const __meta = {
  packageId: "packed-b",
  version: "1.0.0",
  entryAgents: ["writer"],
  packedAt: 1764028800000,
}
