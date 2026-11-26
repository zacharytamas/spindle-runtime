import { defineTool } from "@standardagents/spec"

export default defineTool({
  description: "Print the live history",
  execute: async (state) => {
    const history = state.execution?.messageHistory ?? []
    console.log(`[tool] read_history ${JSON.stringify(history.map((m) => [m.id, m.content]))}`)
    return { status: "success", result: `${history.length} messages` }
  },
})
