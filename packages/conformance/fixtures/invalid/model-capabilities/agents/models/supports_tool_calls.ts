const provider = () => {
  throw new Error("This fixture does not call a provider")
}

// models.md:84 types supportsToolCalls as boolean.
export default {
  name: "supports_tool_calls",
  provider,
  model: "fixture-model",
  capabilities: { supportsToolCalls: "true" },
}
