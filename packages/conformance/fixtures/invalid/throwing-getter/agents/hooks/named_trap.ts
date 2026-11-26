export default {
  get id(): never {
    throw new Error("The id getter of named_trap throws")
  },
  hook: "filter_messages",
  execute: async () => {},
}
