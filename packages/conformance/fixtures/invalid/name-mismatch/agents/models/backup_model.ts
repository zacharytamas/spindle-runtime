const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "backup", provider, model: "fixture-model" }
