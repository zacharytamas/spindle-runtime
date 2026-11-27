export default {
  hook: "filter_messages",
  id: "limit_history",
  execute: async (_state: unknown, messages: Array<unknown>) => messages.slice(-20),
}
