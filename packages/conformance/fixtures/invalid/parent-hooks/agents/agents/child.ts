export default {
  name: "child",
  exposeAsTool: true,
  toolDescription: "A child that requires parent hooks",
  sideA: { prompt: "child" },
  sideB: { human: true },
  parentHooks: [
    { hook: "sync_context", reason: "Shows synchronized context to the parent." },
    { hook: "sync_context", reason: "Declared twice." },
    { hook: "missing_hook", reason: "Refers to a hook that is not defined." },
  ],
}
