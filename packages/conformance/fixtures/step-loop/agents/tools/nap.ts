import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "Wait for a number of milliseconds",
  args: z.object({ ms: z.number().int().min(0).describe("How long to wait") }),
  execute: async (_state, { ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return { status: "success", result: `Slept ${ms} ms` }
  },
})
