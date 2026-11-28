export const agents = {
  gate: async () => ({
    name: "gate",
    exposeAsTool: true,
    toolDescription: "An entry agent that requires a parent hook",
    sideA: { handler: "gate_pipe" },
    sideB: { human: true },
    parentHooks: [{ hook: "share_context", reason: "Shows the gate context to the parent.", stage: "before_parent" }],
  }),
}

export const handlers = {
  gate_pipe: async () => ({ [Symbol.for("standardagents.handler")]: true, execute: async () => {} }),
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
  packageId: "standardagent-gate",
  version: "1.0.0",
  entryAgents: ["gate"],
  packedAt: 1764028800000,
  parentHooks: {
    gate: [{ stage: "before_parent", reason: "Shows the gate context to the parent.", hook: "share_context" }],
  },
}
