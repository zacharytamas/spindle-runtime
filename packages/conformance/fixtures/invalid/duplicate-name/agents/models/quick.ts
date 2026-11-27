const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "fast", provider, model: "fixture-model-2" }
