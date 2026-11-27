const requirement = { hook: "share_context", reason: "Shows the relay context to the parent." }

export const agents = {
  relay: async () => ({
    name: "relay",
    exposeAsTool: true,
    toolDescription: "Relays messages",
    sideA: { handler: "relay_pipe" },
    sideB: { human: true },
    parentHooks: [requirement],
  }),
}

export const handlers = {
  relay_pipe: async () => ({ execute: async () => {} }),
}

export const prompts = {}
export const tools = {}
export const models = {}

export const hooks = {
  share_context: async () => ({
    hook: "filter_messages",
    id: "share_context",
    execute: async (_state, messages) => messages,
  }),
}

export const __meta = {
  packageId: "standardagent-sparse-meta",
  version: "1.0.0",
  entryAgents: ["relay"],
  packedAt: 1764028800000,
  parentHooks: { relay: Object.assign([], { length: 1 }) },
}
