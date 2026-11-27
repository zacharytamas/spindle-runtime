const provider = () => {
  throw new Error("This fixture does not call a provider")
}

// models.md:83 types supportsImages as boolean.
export default { name: "supports_images", provider, model: "fixture-model", capabilities: { supportsImages: "yes" } }
