export default { hook: "filter_messages", id: "trim", execute: async (_state, messages) => messages.slice(-10) }
