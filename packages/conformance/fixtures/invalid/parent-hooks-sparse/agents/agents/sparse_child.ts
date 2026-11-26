export default {
  name: "sparse_child",
  exposeAsTool: true,
  toolDescription: "An agent whose parentHooks array has a missing element",
  sideA: { handler: "relay_pipe" },
  sideB: { human: true },
  parentHooks: Object.assign([{ hook: "share_context", reason: "Shows the context to the parent." }], { length: 2 }),
}
