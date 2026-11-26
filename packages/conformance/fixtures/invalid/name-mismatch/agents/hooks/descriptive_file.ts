export default {
  hook: "filter_messages",
  id: "filter_recent",
  execute: async (_state: unknown, messages: Array<unknown>) => messages.slice(-20),
}
