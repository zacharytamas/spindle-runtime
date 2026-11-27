// packaging.md:183-185 and packaging.md:205-206: parentHooks disclosures duplicate the requirements of entry agents,
// keyed by entry agent. ghost is no agent of this package, so its disclosure duplicates nothing.
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

export const hooks = {
  share_context: async () => ({
    hook: "filter_messages",
    id: "share_context",
    execute: async (_state, messages) => messages,
  }),
}

export const __meta = {
  packageId: "standardagent-ghost-disclosure",
  version: "1.0.0",
  entryAgents: ["opener"],
  packedAt: 1764028800000,
  parentHooks: { ghost: [{ hook: "share_context", reason: "Shows the context to the parent." }] },
}
