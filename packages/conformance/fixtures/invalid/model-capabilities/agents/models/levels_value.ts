const provider = () => {
  throw new Error("This fixture does not call a provider")
}

// models.md:82 types each reasoningLevels value as string | null. 3 is neither.
export default {
  name: "levels_value",
  provider,
  model: "fixture-model",
  capabilities: { reasoningLevels: { 0: null, 100: 3 } },
}
