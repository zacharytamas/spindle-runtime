export default {
  name: "assistant",
  toolDescription: "General-purpose assistant",
  model: "conversational",
  prompt: [
    { type: "text", content: "You are a helpful assistant.\n\n" },
    { type: "include", prompt: "house_rules" },
  ],
  tools: ["lookup", { name: "summarize", includeToolCalls: false }, "web_search"],
  includeChat: true,
  toolChoice: "auto",
  reasoning: { level: 50 },
  recentImageThreshold: 10,
  hooks: ["limit_history", "drop_empty"],
}
