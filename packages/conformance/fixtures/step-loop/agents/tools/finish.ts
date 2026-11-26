import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "End the turn with a summary",
  args: z.object({ summary: z.string().describe("What was done") }),
  execute: async (_state, { summary }) => ({ status: "success", result: JSON.stringify({ summary }) }),
})
