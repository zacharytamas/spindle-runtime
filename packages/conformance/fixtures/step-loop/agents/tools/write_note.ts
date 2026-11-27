import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "Save a note under a key",
  args: z.object({ key: z.string().describe("The name of the note"), value: z.string().describe("The note") }),
  execute: async (state, { key, value }) => {
    await state.setValue(key, value)
    return { status: "success", result: `Saved ${key}` }
  },
})
