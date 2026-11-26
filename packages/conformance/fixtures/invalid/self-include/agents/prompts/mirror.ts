export default {
  name: "mirror",
  toolDescription: "Includes itself",
  model: "conversational",
  prompt: [{ type: "include", prompt: "mirror" }],
}
