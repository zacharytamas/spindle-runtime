import { defineTool } from "@standardagents/spec"

export default defineTool({
  description: "A tool that always throws",
  execute: async () => {
    throw new Error("The explode tool failed on purpose")
  },
})
