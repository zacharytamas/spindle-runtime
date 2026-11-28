export const __meta = { packageId: "before", version: "1.0.0", entryAgents: ["relay"], packedAt: 0 }

export const agents = {
  relay: async () => ({ name: "relay", sideA: { human: true }, sideB: { handler: "reply" } }),
}
export const handlers = { reply: async () => ({ [Symbol.for("standardagents.handler")]: true, execute() {} }) }
export const hooks = {}
export const tools = {}
export const models = { model: async () => ({ name: "model", model: "fixture", provider() {} }) }
export const prompts = {
  example: async () => {
    let reads = 0
    return {
      get name() {
        this.__package.packageId = "after"
        return "example"
      },
      model: "model",
      toolDescription: "Example",
      get prompt() {
        if (++reads === 3) throw new Error("The prompt changed during cycle discovery")
        return []
      },
    }
  },
}
