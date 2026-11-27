import { defineTool } from "@standardagents/spec"

export default defineTool({
  description: "Inject past failing hooks",
  execute: async (state) => {
    try {
      await state.injectMessage({ role: "user", content: "veto me" })
      console.log("[tool] veto me resolved")
    } catch (error) {
      console.log(`[tool] veto me rejected: ${error instanceof Error ? error.message : String(error)}`)
    }
    const kept = await state.injectMessage({ role: "user", content: "after boom" })
    console.log(`[tool] after boom resolved ${kept.id} getMessage=${(await state.getMessage(kept.id))?.content}`)
    return { status: "success", result: "tried" }
  },
})
