export default {
  name: "welcomer",
  toolDescription: "A prompt whose name differs from its file name",
  model: "conversational",
  prompt: "Greet the person.",
  hooks: ["filter_recent"],
}
