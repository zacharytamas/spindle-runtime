const provider = () => {
  throw new Error("This fixture does not call a provider")
}

export default { name: "no_model", provider, model: "" }
