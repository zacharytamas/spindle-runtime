const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "bad_price", provider, model: "fixture-model", inputPrice: -1 }
