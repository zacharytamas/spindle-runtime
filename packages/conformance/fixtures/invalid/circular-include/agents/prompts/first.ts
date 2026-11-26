export default {
  name: "first",
  toolDescription: "Includes second",
  model: "conversational",
  prompt: [{ type: "include", prompt: "second" }],
}
