export default {
  name: "assistant",
  toolDescription: "The assistant prompt",
  model: "conversational",
  prompt: "Help the person.",
  hooks: ["missing_hook", "relay_pipe"],
}
