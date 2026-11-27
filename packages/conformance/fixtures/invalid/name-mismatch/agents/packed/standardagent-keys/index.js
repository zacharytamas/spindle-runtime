const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export const agents = {
  entry: async () => ({
    name: "entry",
    exposeAsTool: true,
    toolDescription: "An entry agent whose prompt has another export key",
    sideA: { prompt: "main_prompt" },
    sideB: { human: true },
  }),
}

export const handlers = {}

export const prompts = {
  main: async () => ({
    name: "main_prompt",
    toolDescription: "A prompt exported under the key main",
    model: "fast",
    prompt: "Help the person.",
  }),
}

export const tools = {}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {}

export const __meta = {
  packageId: "standardagent-keys",
  version: "1.0.0",
  entryAgents: ["entry"],
  packedAt: 1764028800000,
}
