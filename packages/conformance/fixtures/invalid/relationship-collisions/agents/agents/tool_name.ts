export default {
  name: "tool_name",
  sideA: { prompt: "coordinator", subagents: [{ agent: "helper", as: "lookup" }] },
  sideB: { human: true },
}
