export default {
  name: "intake",
  description: "A person on side A hands each request to a handler on side B",
  primary: false,
  maxSessionTurns: 4,
  sideA: { human: true },
  sideB: { handler: "relay_pipe" },
}
