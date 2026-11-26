export default {
  name: "relay",
  sideA: { handler: "relay_pipe", maxSteps: 5, sessionStop: { name: "finish" }, stopOnResponse: false },
  sideB: { human: true, stopOnResponse: true },
}
