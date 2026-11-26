export const agents = {
  relay: async () => ({
    name: "relay",
    exposeAsTool: true,
    toolDescription: "Relays messages",
    sideA: { handler: "relay_pipe" },
    sideB: { human: true },
    parentHooks: [
      { hook: "share_context", reason: "Shows the relay context to the parent." },
      { hook: "host_only", reason: "Names a hook that only the host project defines." },
      { hook: "standardagent-broken/share_context", reason: "Names share_context again by its qualified name." },
    ],
  }),
}

export const handlers = {}

export const prompts = {
  sync_prompt: () => ({
    name: "sync_prompt",
    toolDescription: "A prompt whose loader returns a value instead of a Promise",
    model: "missing",
    prompt: "Help the person.",
  }),
}

export const tools = {
  fetch_page: async () => ({
    description: "Fetches a page and formats it",
    execute: async () => ({ status: "success", result: "" }),
    uses: ["format_page"],
  }),
}

export const models = {}

export const hooks = {
  share_context: async () => ({
    hook: "filter_messages",
    id: "share_context",
    execute: async (_state, messages) => messages,
  }),
}

export const __meta = {
  packageId: "standardagent-broken",
  version: "1.0.0",
  entryAgents: ["relay", "ghost"],
  packedAt: 1764028800000,
}
