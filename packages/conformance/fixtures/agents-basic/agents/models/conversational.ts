const provider = () => {
  throw new Error("The agents-basic fixture does not call a provider")
}

export default {
  name: "conversational",
  provider,
  model: "fixture-model",
  fallbacks: [],
  providerTools: ["web_search"],
}
