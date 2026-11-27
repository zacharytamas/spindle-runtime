const provider = () => {
  throw new Error("This fixture does not call a provider")
}

// models.md:85 types supportsStreaming as boolean.
export default { name: "supports_streaming", provider, model: "fixture-model", capabilities: { supportsStreaming: 1 } }
