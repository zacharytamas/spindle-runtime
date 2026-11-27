const provider = () => {
  throw new Error("This fixture does not call a provider")
}

// models.md:87 types maxContextTokens as number.
export default {
  name: "max_context_tokens",
  provider,
  model: "fixture-model",
  capabilities: { maxContextTokens: "128k" },
}
