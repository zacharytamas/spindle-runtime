import { defineTool } from "@standardagents/spec"

export default defineTool({
  description: "Return at once",
  execute: async () => ({ status: "success", result: "ok" }),
})
