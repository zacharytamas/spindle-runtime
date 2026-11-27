export default {
  name: "bindings",
  sideA: {
    handler: "relay_pipe",
    stopTool: "finish",
    stopToolResponseProperty: "result",
    sessionFail: { name: "fail" },
    sessionStatus: { name: "status" },
  },
  sideB: { human: true, maxSteps: 3, sessionStatus: { name: "status" } },
}
