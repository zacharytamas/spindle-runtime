const provider = () => {
  throw new Error("The standardagent-loud fixture runs only with --script")
}

export const agents = {
  loud: async () => ({
    name: "loud",
    sideA: { prompt: "loud" },
    sideB: { human: true },
    hooks: ["stamp_loud"],
  }),
}

export const handlers = {}

export const prompts = {
  loud: async () => ({
    name: "loud",
    toolDescription: "Answers with its package hook",
    model: "fast",
    prompt: "You are a test assistant.",
  }),
}

export const tools = {}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {
  stamp_loud: async () => ({
    hook: "before_create_message",
    id: "stamp_loud",
    execute: async (_state, message) => ({ ...message, metadata: { ...message.metadata, loud: true } }),
  }),
}

export const effects = {}

export const __meta = {
  packageId: "standardagent-loud",
  version: "1.0.0",
  entryAgents: ["loud"],
  packedAt: 1764028800000,
}
