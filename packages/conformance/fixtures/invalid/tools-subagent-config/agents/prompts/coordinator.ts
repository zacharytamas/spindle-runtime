export default {
  name: "coordinator",
  toolDescription: "The coordinator prompt",
  model: "conversational",
  prompt: "Help the person.",
  tools: [{ name: "helper", agent: "helper", maxInstances: 2 }],
}
