const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default {
  name: "no_reasoning",
  provider,
  model: "fixture-model",
  capabilities: { reasoningLevels: { 0: null } },
}
