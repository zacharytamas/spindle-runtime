export default {
  name: "assistant",
  title: "Assistant",
  exposeAsTool: true,
  toolDescription: "Answers questions concisely",
  sideA: { prompt: "assistant", stopOnResponse: true, maxSteps: 8 },
  sideB: { human: true, label: "Person" },
  hooks: ["limit_history"],
  maxSessionTurns: 50,
  packageName: "agents-basic",
  version: "1.0.0",
  author: "Spindle",
  license: "MIT",
}
