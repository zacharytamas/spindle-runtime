export const agents = {}
export const handlers = {}
export const prompts = {}
export const tools = {}
export const models = {}
export const hooks = {}

export const __meta = {
  packageId: "standardagent-meta-trap",
  get version() {
    throw new Error("The version getter of __meta throws")
  },
  entryAgents: [],
  packedAt: 1764028800000,
}
