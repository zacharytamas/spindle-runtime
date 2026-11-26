export default {
  name: "content_trap",
  toolDescription: "A prompt whose content getter throws",
  model: "fixture_model",
  get prompt(): never {
    throw new Error("The prompt getter of content_trap throws")
  },
}
