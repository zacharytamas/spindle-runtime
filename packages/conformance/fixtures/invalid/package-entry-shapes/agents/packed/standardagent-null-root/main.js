globalThis.spindleImportedRejectedEntry = true

export const agents = {}
export const handlers = {}
export const prompts = {}
export const models = {}
export const hooks = {}

export const tools = {
  null_root: async () => ({
    description: "A tool that shows which entry file Spindle imported",
    execute: async () => ({ status: "success", result: "" }),
  }),
}

export const __meta = {
  packageId: "standardagent-null-root",
  version: "1.0.0",
  entryAgents: [],
  packedAt: 1764028800000,
}
