export default {
  name: "second",
  toolDescription: "Includes first",
  model: "conversational",
  prompt: [
    { type: "text", content: "Rules: " },
    { type: "include", prompt: "first" },
  ],
}
