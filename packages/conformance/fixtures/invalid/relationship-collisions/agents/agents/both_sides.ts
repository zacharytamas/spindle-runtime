export default {
  name: "both_sides",
  sideA: { prompt: "helper", subagents: [{ agent: "helper" }] },
  sideB: { prompt: "helper", subagents: [{ agent: "helper" }] },
}
