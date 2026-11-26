import { defineTool } from "@standardagents/spec"

export default defineTool({
  description: "Print the live history and the default read",
  execute: async (state) => {
    const live = state.execution?.messageHistory ?? []
    const plain = await state.getMessages({ order: "asc" })
    const all = await state.getMessages({ order: "asc", includeSilent: true })
    console.log(`[tool] messageHistory ${JSON.stringify(live.map((m) => m.content))}`)
    console.log(`[tool] getMessages ${JSON.stringify(plain.messages.map((m) => m.content))}`)
    console.log(`[tool] getMessages includeSilent ${JSON.stringify(all.messages.map((m) => m.content))}`)
    return { status: "success", result: "shown" }
  },
})
