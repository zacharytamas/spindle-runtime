// effects.md:95-101 types the second element of an EffectDefinition as ToolArgs | null,
// and ToolArgs in @standardagents/spec (index.d.ts:275-282) is a Zod object schema. A plain object is neither.
export default ["Send a reminder", { to: "string" }, async () => {}]
