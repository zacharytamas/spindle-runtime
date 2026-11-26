export const tools = {
  lookup: async () => ({
    description: "The only definition of a package that exports no other registry",
    execute: async () => ({ status: "success", result: "" }),
  }),
}

export const __meta = {
  packageId: "standardagent-tools-only",
  version: "1.0.0",
  entryAgents: [],
  packedAt: 1764028800000,
}
