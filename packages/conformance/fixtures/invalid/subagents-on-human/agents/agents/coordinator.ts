export default {
  name: "coordinator",
  sideA: { prompt: "helper" },
  sideB: { human: true, subagents: [{ agent: "helper" }] },
}
