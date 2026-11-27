// agents.md:41 and agents.md:287 type stopOnResponse as boolean. The string "false" is not one, and it is truthy.
export default {
  name: "stringly",
  sideA: { prompt: "assistant", stopOnResponse: "false" },
  sideB: { human: true },
}
