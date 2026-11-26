export default {
  name: "relay",
  sideA: { handler: "relay_pipe", maxSteps: 5, sessionStop: { name: "finish" } },
  sideB: { human: true, stopOnResponse: true },
}
