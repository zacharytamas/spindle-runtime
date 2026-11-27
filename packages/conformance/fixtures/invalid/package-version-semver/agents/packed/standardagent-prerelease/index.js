const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export const agents = {
  opener: async () => ({ name: "opener", sideA: { prompt: "reply" }, sideB: { human: true } }),
  closer: async () => ({ name: "closer", sideA: { prompt: "reply" }, sideB: { human: true } }),
}

export const handlers = {}

export const prompts = {
  reply: async () => ({ name: "reply", toolDescription: "Replies", model: "fast", prompt: "Reply briefly." }),
}

export const tools = {}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {}

export const __meta = {
  packageId: "standardagent-prerelease",
  version: "1.2.3-beta.1+build.5",
  entryAgents: ["opener"],
  packedAt: 1764028800000,
}
