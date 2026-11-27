// ToolArgs in @standardagents/spec (index.d.ts:275-282): "Tool arguments MUST be defined as a Zod object schema."
// A JSON Schema object is not a Zod schema.
export default {
  description: "Takes a JSON Schema in place of a Zod schema",
  args: { type: "object", properties: { query: { type: "string" } } },
  execute: async () => ({ status: "success", result: "done" }),
}
