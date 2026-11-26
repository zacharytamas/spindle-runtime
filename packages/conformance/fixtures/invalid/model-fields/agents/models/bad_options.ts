const provider = Object.assign(
  () => {
    throw new Error("This fixture does not call a provider")
  },
  {
    providerOptions: {
      safeParse: (options: { seed?: unknown }) =>
        typeof options.seed === "number"
          ? { success: true }
          : { success: false, error: new Error("seed must be a number") },
    },
  },
)

export default { name: "bad_options", provider, model: "fixture-model", providerOptions: { seed: "forty-two" } }
