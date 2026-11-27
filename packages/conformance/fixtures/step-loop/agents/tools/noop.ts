import { defineTool } from "@standardagents/spec"

export default defineTool({
  description: "Return at once",
  annotations: { spindle_test: { sentinel: "kept as written" }, someone_else: { codemode: { codeArgument: "x" } } },
  execute: async () => ({ status: "success", result: "ok" }),
})
