export default {
  name: "coordinator",
  toolDescription: "Names a prompt tool and a provider tool with reserved names",
  model: "conversational",
  prompt: "Coordinate the work.",
  tools: ["subagents", "subagent_message"],
}
