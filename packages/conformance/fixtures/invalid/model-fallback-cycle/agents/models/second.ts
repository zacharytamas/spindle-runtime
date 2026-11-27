const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "second", provider, model: "fixture-model", fallbacks: ["third"] }
