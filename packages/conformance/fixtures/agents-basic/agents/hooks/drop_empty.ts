export default {
  hook: "filter_messages",
  id: "drop_empty",
  execute: async (_state: unknown, messages: Array<{ content?: string | null }>) =>
    messages.filter((message) => message.content !== ""),
}
