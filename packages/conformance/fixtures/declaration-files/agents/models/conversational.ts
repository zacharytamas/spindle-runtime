const provider = () => {
  throw new Error("The declaration-files fixture does not call a provider")
}

export default {
  name: "conversational",
  provider,
  model: "fixture-model",
}
