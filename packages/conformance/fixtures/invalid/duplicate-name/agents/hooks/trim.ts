export default {
  hook: "filter_messages",
  id: "trim",
  execute: async (_state: unknown, messages: Array<unknown>) => messages.slice(-10),
}
