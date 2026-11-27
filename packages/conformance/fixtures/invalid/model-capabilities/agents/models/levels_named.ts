const provider = () => {
  throw new Error("This fixture does not call a provider")
}

// models.md:82 types reasoningLevels as Record<number, string | null>. "high" is not a number.
export default {
  name: "levels_named",
  provider,
  model: "fixture-model",
  capabilities: { reasoningLevels: { 0: null, high: "high" } },
}
