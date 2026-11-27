export default {
  description: "A tool that declares a target that is not defined",
  execute: async () => ({ status: "success", result: "" }),
  uses: ["missing_tool"],
}
