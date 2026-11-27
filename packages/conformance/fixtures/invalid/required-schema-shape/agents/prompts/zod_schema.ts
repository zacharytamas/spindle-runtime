import { z } from "zod"

export default {
  name: "zod_schema",
  toolDescription: "The zod_schema prompt",
  model: "conversational",
  prompt: "Help the person.",
  requiredSchema: z.object({ query: z.string().describe("Search query"), limit: z.number().optional().default(10) }),
}
