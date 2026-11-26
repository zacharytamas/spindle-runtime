enum Status {
  Found = "found",
}

export default {
  description: "Look up a word",
  args: null,
  execute: async () => ({ status: "success", result: Status.Found }),
}
