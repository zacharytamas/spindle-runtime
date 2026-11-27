export default {
  description: "End the turn with a summary",
  args: null,
  execute: async () => ({ status: "success", result: JSON.stringify({ summary: "closed" }) }),
}
