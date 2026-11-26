export default {
  name: "relay",
  sideA: { handler: "relay_pipe", subagents: [{ agent: "assistant", as: "helper", maxInstances: 1 }] },
  sideB: { human: true },
}
