const provider = () => {
  throw new Error("This fixture does not call a provider")
}

// models.md:86 types supportsJsonMode as boolean.
export default {
  name: "supports_json_mode",
  provider,
  model: "fixture-model",
  capabilities: { supportsJsonMode: "no" },
}
