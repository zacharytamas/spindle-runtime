// packaging.md:197-198 declares __meta.version as the package version in semver. "1.0" has two parts, so it is not semver.
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
  packageId: "standardagent-loose-version",
  version: "1.0",
  entryAgents: ["opener"],
  packedAt: 1764028800000,
}
