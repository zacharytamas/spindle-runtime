const provider = () => {
  throw new Error("This fixture does not call a provider")
}

// models.md:88 types maxOutputTokens as number.
export default { name: "max_output_tokens", provider, model: "fixture-model", capabilities: { maxOutputTokens: true } }
