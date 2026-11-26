export const agents = {}
export const handlers = {}
export const prompts = {}
export const models = {}
export const hooks = {}

export const tools = {
  lookup: async () => ({
    description: "A tool of a package whose packageId is a local identifier",
    execute: async () => ({ status: "success", result: "" }),
  }),
}

export const __meta = {
  packageId: "local_tools",
  version: "1.0.0",
  entryAgents: [],
  packedAt: 1764028800000,
}
