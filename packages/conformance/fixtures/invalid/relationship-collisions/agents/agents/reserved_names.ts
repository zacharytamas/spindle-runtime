export default {
  name: "reserved_names",
  sideA: {
    prompt: "helper",
    subagents: [
      { agent: "helper", as: "subagents" },
      { agent: "helper", as: "subagent_message" },
    ],
  },
  sideB: { human: true },
}
