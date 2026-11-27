const provider = () => {
  throw new Error("The standardagent-closer fixture runs only with --script")
}

export const agents = {
  closer: async () => ({
    name: "closer",
    sideA: { prompt: "closer", stopTool: "standardagent-closer/finish", stopToolResponseProperty: "summary" },
    sideB: { human: true },
  }),
}

export const handlers = {}

export const prompts = {
  closer: async () => ({
    name: "closer",
    toolDescription: "Finishes with a summary",
    model: "fast",
    prompt: "Call finish when you are done.",
    tools: ["finish"],
  }),
}

export const tools = {
  finish: async () => ({
    description: "End the turn with a summary",
    args: null,
    execute: async () => ({ status: "success", result: JSON.stringify({ summary: "closed" }) }),
  }),
}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {}

export const effects = {}

export const __meta = {
  packageId: "standardagent-closer",
  version: "1.0.0",
  entryAgents: ["closer"],
  packedAt: 1764028800000,
}
