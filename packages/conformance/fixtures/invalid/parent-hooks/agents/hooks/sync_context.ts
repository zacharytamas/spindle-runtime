export default {
  hook: "filter_messages",
  id: "sync_context",
  execute: async (_state: unknown, messages: Array<unknown>) => messages,
}
