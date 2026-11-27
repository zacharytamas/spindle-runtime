const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "empty", provider, model: "fixture-model", capabilities: {} }
