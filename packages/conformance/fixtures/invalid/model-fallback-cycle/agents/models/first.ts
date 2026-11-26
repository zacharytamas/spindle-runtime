const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "first", provider, model: "fixture-model", fallbacks: ["second"] }
