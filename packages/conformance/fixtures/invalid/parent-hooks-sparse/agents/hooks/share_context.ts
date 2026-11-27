export default {
  hook: "filter_messages",
  id: "share_context",
  execute: async (_state: unknown, messages: unknown) => messages,
}
