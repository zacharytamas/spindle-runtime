const shared = {
  name: "inherited",
  provider: () => {
    throw new Error("This fixture does not call a provider")
  },
  model: "fixture-model",
}

export default Object.create(shared)
