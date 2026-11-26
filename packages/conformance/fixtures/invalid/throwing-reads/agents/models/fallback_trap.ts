export default {
  name: "fallback_trap",
  provider: () => ({}),
  model: "fixture-model",
  get fallbacks(): never {
    throw new Error("The fallbacks getter of fallback_trap throws")
  },
}
