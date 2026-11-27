import { z } from "zod"

// prompts.md:30 and PromptDefinition in @standardagents/spec (index.d.ts:4309, 4367): requiredSchema extends ToolArgs,
// a Zod object schema. A Zod string schema is not one.
export default {
  name: "string_schema",
  toolDescription: "The string_schema prompt",
  model: "conversational",
  prompt: "Help the person.",
  requiredSchema: z.string(),
}
