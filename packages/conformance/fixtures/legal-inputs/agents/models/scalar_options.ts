const provider = Object.assign(
  () => {
    throw new Error("This fixture does not call a provider")
  },
  {
    providerOptions: {
      safeParse: (options: unknown) =>
        typeof options === "string"
          ? { success: true, data: options }
          : { success: false, error: new Error("Expected a string") },
    },
  },
)

export default { name: "scalar_options", provider, model: "fixture-model", providerOptions: "low-latency" }
