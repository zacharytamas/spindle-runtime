const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "bad_fallback", provider, model: "fixture-model", fallbacks: ["no_model", "missing_model"] }
