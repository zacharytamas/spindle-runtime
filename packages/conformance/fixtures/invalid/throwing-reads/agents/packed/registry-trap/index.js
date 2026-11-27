export const agents = {}
export const handlers = {}
export const prompts = {}
export const models = {}
export const hooks = {}

export const tools = {
  get lookup() {
    throw new Error("The lookup getter of tools throws")
  },
}

export const __meta = {
  packageId: "standardagent-registry-trap",
  version: "1.0.0",
  entryAgents: [],
  packedAt: 1764028800000,
}
