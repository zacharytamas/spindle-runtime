import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "Record a count with a label",
  args: z.object({ count: z.number().int().min(1).describe("How many"), label: z.string().describe("What they are") }),
  execute: async (state, { count, label }) => {
    await state.setValue("strict_ran", true)
    return { status: "success", result: `${count} ${label}` }
  },
})
