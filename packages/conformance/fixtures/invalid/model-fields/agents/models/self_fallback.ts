const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "self_fallback", provider, model: "fixture-model", fallbacks: ["self_fallback"] }
