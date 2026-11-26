import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "Save a note under a key",
  args: z.object({ key: z.string(), value: z.string() }),
  execute: async (state, { key, value }) => {
    await state.setValue(key, value)
    return { status: "success", result: `Saved ${key}` }
  },
})
