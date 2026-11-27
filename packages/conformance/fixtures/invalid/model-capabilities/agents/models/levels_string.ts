const provider = () => {
  throw new Error("This fixture does not call a provider")
}

// models.md:82 types reasoningLevels as Record<number, string | null>. A string is not a record.
export default { name: "levels_string", provider, model: "fixture-model", capabilities: { reasoningLevels: "high" } }
