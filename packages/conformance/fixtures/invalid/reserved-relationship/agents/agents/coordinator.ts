export default {
  name: "coordinator",
  sideA: { prompt: "coordinator", subagents: [{ agent: "helper", as: "subagent_create" }] },
  sideB: { human: true },
}
