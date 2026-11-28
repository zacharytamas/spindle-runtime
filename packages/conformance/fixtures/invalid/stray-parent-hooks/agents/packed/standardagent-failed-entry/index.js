// packaging.md:183-185: the disclosures below are correct for the agent this loader would return. The loader fails,
// so its parentHooks cannot be read, and the disclosures must not be called stray on that account.
export const agents = {
  gate: async () => {
    throw new Error("the gate agent cannot load")
  },
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
  packageId: "standardagent-failed-entry",
  version: "1.0.0",
  entryAgents: ["gate"],
  packedAt: 1764028800000,
  parentHooks: {
    gate: [{ stage: "before_parent", reason: "Shows the gate context to the parent.", hook: "share_context" }],
  },
}
