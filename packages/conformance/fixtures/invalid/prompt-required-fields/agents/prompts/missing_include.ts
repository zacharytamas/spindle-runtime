export default {
  name: "missing_include",
  toolDescription: "A prompt that includes a prompt that is not defined",
  model: "conversational",
  prompt: [{ type: "include", prompt: "nowhere" }],
}
