const provider = () => {
  throw new Error("The standardagent-callee fixture does not call a provider")
}

export const agents = {
  finder: async () => ({
    name: "finder",
    exposeAsTool: true,
    toolDescription: "The entry agent of standardagent-callee",
    sideA: { prompt: "finder" },
    sideB: { human: true },
  }),
}

export const handlers = {}

export const prompts = {
  finder: async () => ({
    name: "finder",
    toolDescription: "The prompt of the standardagent-callee entry agent",
    model: "fast",
    prompt: "Find what the person asks for.",
  }),
}

export const tools = {}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {}

export const effects = {}

export const __meta = {
  packageId: "standardagent-callee",
  version: "1.0.0",
  entryAgents: ["finder"],
  packedAt: 1764028800000,
}
