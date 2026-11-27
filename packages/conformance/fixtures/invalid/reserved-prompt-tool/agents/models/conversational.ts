const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "conversational", provider, model: "fixture-model", providerTools: ["subagent_message"] }
