import { defineTool } from "@standardagents/spec"

export default defineTool({
  description: "Inject a note and read it back",
  execute: async (state) => {
    const message = await state.injectMessage({ role: "user", content: "note from inject_note" })
    const read = await state.getMessage(message.id)
    console.log(`[tool] inject_note ${message.id} getMessage=${read?.content}`)
    return { status: "success", result: message.id }
  },
})
