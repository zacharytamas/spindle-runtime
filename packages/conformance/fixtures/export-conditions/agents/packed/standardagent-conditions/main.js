export const agents = {}
export const handlers = {}
export const prompts = {}

export const tools = {
  lookup: async () => ({
    description: "A tool of a package whose only entry is under the node condition",
    execute: async () => ({ status: "success", result: "" }),
  }),
}

export const models = {}
export const hooks = {}

export const __meta = {
  packageId: "standardagent-conditions",
  version: "1.0.0",
  entryAgents: [],
  packedAt: 1764028800000,
}
