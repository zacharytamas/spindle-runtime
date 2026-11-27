export default {
  description: "Look up a word in the glossary",
  args: null,
  execute: async () => ({ status: "success", result: "A glossary entry" }),
  uses: ["summarize"],
}
