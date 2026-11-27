import { z } from "zod"

// ToolArgs in @standardagents/spec (index.d.ts:275-282) is z.ZodObject. A Zod string schema is not an object schema.
export default {
  description: "Takes a Zod string schema",
  args: z.string(),
  execute: async () => ({ status: "success", result: "done" }),
}
