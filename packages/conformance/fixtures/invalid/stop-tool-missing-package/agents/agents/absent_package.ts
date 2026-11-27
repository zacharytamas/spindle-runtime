// agents.md:42 and agents.md:288: stopTool names the tool whose call stops the side's turn. packaging.md:232-236: a
// qualified name is {packageId}/{name} and resolves only by the visibility rules. No package standardagent-absent is
// installed, so no tool by this name can be called and the stop never happens.
export default {
  name: "absent_package",
  sideA: { prompt: "finisher", stopTool: "standardagent-absent/finish" },
  sideB: { human: true },
}
