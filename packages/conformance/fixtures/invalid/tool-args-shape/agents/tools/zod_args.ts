import { z } from "zod"

export default {
  description: "Takes a Zod object schema",
  args: z.object({ query: z.string(), limit: z.number().optional() }),
  execute: async () => ({ status: "success", result: "done" }),
}
