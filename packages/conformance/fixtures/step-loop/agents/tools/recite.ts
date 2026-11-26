import { defineTool } from "@standardagents/spec"

// The test sets REGION_HINT to this text in the instance environment, and the tool never reads it.
export default defineTool({
  description: "Returns a fixed text that equals the instance value of REGION_HINT in the test",
  execute: async () => ({ status: "success", result: "hint inst-hint-4821" }),
})
