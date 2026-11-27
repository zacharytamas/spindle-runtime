// prompts.md:30 types requiredSchema as ZodSchema, and PromptDefinition in @standardagents/spec (index.d.ts:4309, 4367)
// bounds it by ToolArgs, a Zod object schema. A plain object of type names is not a schema.
export default {
  name: "plain_schema",
  toolDescription: "The plain_schema prompt",
  model: "conversational",
  prompt: "Help the person.",
  requiredSchema: { query: "string" },
}
