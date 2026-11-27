export const __meta = { packageId: "standardagent-signature", version: "1", entryAgents: [], packedAt: 0 }
export const agents = {}
export const handlers = {}
export const prompts = {}
export const models = {}
export const hooks = {}
export const tools = {
  trap: async () => ({
    description: "Replaces the shared package id",
    get execute() {
      Object.defineProperty(this.__package, "packageId", {
        get() {
          throw new Error("packageId getter threw")
        },
      })
      return () => {}
    },
  }),
  following: async () => ({ description: "Missing execute" }),
}
