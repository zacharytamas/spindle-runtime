import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "Read the note saved under a key",
  args: z.object({ key: z.string().describe("The name of the note") }),
  execute: async (state, { key }) => {
    const value = await state.getValue(key)
    return { status: "success", result: value === null ? `No note named ${key}` : `${key} is ${String(value)}` }
  },
})
