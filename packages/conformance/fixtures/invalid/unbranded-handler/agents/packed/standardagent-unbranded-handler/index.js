const HANDLER_SYMBOL = Symbol.for("standardagents.handler")

export const agents = {}
export const prompts = {}
export const tools = {}
export const models = {}
export const hooks = {}
export const handlers = {
  plain: async () => ({
    description: "Unbranded packed handler",
    execute: async () => {},
  }),
  branded: async () => ({
    description: "Branded packed handler",
    execute: async () => {},
    [HANDLER_SYMBOL]: true,
  }),
}
export const __meta = {
  packageId: "standardagent-unbranded-handler",
  version: "1.0.0",
  entryAgents: [],
  packedAt: 1764028800000,
}
