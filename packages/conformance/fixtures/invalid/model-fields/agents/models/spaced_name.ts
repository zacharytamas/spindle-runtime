const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "spaced name", provider, model: "fixture-model" }
