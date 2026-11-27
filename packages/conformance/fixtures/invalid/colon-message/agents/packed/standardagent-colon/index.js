export const agents = {}
export const handlers = {}
export const prompts = {}
export const models = {}
export const hooks = {}
export const tools = {
  // A loader that fails with a message shaped like "word: text" fails with that message.
  lookup: async () => {
    throw new Error("network: the registry is unreachable")
  },
}
export const __meta = { packageId: "standardagent-colon", version: "1.0.0", entryAgents: [], packedAt: 1764028800000 }
