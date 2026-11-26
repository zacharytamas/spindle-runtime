export default {
  hook: "filter_messages",
  id: "BadId",
  execute: async (_state: unknown, messages: Array<unknown>) => messages,
}
