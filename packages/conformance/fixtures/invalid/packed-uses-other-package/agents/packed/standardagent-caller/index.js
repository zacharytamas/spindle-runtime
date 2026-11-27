const provider = () => {
  throw new Error("The standardagent-caller fixture does not call a provider")
}

export const agents = {
  caller: async () => ({
    name: "caller",
    exposeAsTool: true,
    toolDescription: "The entry agent of standardagent-caller",
    sideA: { prompt: "caller" },
    sideB: { human: true },
  }),
}

export const handlers = {}

export const prompts = {
  caller: async () => ({
    name: "caller",
    toolDescription: "The prompt of the standardagent-caller entry agent",
    model: "fast",
    prompt: "Search with the tools you have.",
    tools: ["relay_search", "local_search"],
  }),
}

export const tools = {
  // Names the entry agent of another installed package, which this package does not include.
  relay_search: async () => ({
    description: "Asks the entry agent of standardagent-callee",
    execute: async () => ({ status: "success", result: "" }),
    uses: ["standardagent-callee/finder"],
  }),
  // Names a tool of this package, once by its local name and once by its qualified name.
  local_search: async () => ({
    description: "Formats a result with a tool of this package",
    execute: async () => ({ status: "success", result: "" }),
    uses: ["format_result", "standardagent-caller/format_result"],
  }),
  format_result: async () => ({
    description: "Formats a result",
    execute: async () => ({ status: "success", result: "" }),
  }),
}

export const models = {
  fast: async () => ({ name: "fast", provider, model: "fixture-model" }),
}

export const hooks = {}

export const effects = {}

export const __meta = {
  packageId: "standardagent-caller",
  version: "1.0.0",
  entryAgents: ["caller"],
  packedAt: 1764028800000,
}
