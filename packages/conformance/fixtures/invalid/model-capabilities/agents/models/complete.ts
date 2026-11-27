const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default {
  name: "complete",
  provider,
  model: "fixture-model",
  capabilities: {
    reasoningLevels: { 0: null, 33: "low", 66: "medium", 100: "high" },
    supportsImages: true,
    supportsToolCalls: false,
    supportsStreaming: true,
    supportsJsonMode: false,
    maxContextTokens: 128000,
    maxOutputTokens: 4096,
  },
}
