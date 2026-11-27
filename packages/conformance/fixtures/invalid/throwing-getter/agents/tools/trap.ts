export default {
  description: "A tool whose execute getter throws",
  get execute(): never {
    throw new Error("The execute getter of trap throws")
  },
}
