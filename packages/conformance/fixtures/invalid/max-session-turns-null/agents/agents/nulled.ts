// agents.md:84 and agents.md:318 type maxSessionTurns as an optional number. null is not a number.
// validateAgentDefinition in @standardagents/spec accepts null, so this is a divergence the spec text decides.
export default {
  name: "nulled",
  maxSessionTurns: null,
  sideA: { prompt: "assistant" },
  sideB: { human: true },
}
