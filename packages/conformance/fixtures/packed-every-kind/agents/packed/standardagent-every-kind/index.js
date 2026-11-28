const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export const agents = {
  relay: async () => ({
    name: "relay",
    exposeAsTool: true,
    toolDescription: "Relays messages",
    sideA: { handler: "relay_pipe" },
    sideB: { human: true },
  }),
}

export const handlers = {
  relay_pipe: async () => ({ [Symbol.for("standardagents.handler")]: true, execute: async () => {} }),
}

export const prompts = {
  summarize: async () => ({
    name: "summarize",
    toolDescription: "Summarizes the thread",
    model: "fast",
    prompt: "Summarize the thread.",
    tools: ["lookup"],
    hooks: ["drop_empty"],
  }),
}

export const tools = {
  lookup: async () => ({
    description: "Looks up a record",
    execute: async () => ({ status: "success", result: "" }),
  }),
}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {
  drop_empty: async () => ({
    hook: "filter_messages",
    id: "drop_empty",
    execute: async (_state, messages) => messages,
  }),
}

export const effects = {
  send_digest: async () => ["Send a digest email", null, async () => {}],
}

export const __meta = {
  packageId: "standardagent-every-kind",
  version: "1.0.0",
  entryAgents: ["relay"],
  packedAt: 1764028800000,
}
