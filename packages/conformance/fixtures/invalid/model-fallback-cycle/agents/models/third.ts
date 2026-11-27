const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "third", provider, model: "fixture-model", fallbacks: ["first"] }
