import { type Cause, Deferred, Effect, Queue, Terminal } from "effect"

export const openChatTerminal = Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal
  const closed = yield* Deferred.make<void>()
  const lines = yield* Queue.make<string, Cause.Done>()
  const input = process.stdin
  const output = process.stdout
  let partial = ""
  const receive = (chunk: string) => {
    if (chunk.includes("\n")) input.pause()
    let start = 0
    for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
      const line = partial + chunk.slice(start, end)
      Queue.offerUnsafe(lines, line.endsWith("\r") ? line.slice(0, -1) : line)
      partial = ""
      start = end + 1
    }
    partial += chunk.slice(start)
  }
  const finish = () => {
    if (partial.length > 0) Queue.offerUnsafe(lines, partial)
    partial = ""
    Queue.endUnsafe(lines)
  }
  const outputClosed = () => Deferred.doneUnsafe(closed, Effect.void)
  // A failed pipe write calls both the write callback and the stream's error listener.
  output.on("error", outputClosed)
  input.setEncoding("utf8")
  input.pause()
  input.on("data", receive)
  input.once("end", finish)
  input.once("close", finish)
  if (input.readableEnded) finish()
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      input.pause()
      input.off("data", receive).off("end", finish).off("close", finish)
      // Node can emit the error on its next tick, after display has reported it and the scope has closed.
      setImmediate(() => output.off("error", outputClosed))
    }),
  )
  return {
    isTerminal: input.isTTY === true,
    readLine: Effect.suspend(() => {
      // Resume the pipe only when the prompt has consumed every line from the last chunk.
      if (Queue.sizeUnsafe(lines) === 0) input.resume()
      return Queue.take(lines).pipe(Effect.orElseSucceed(() => null))
    }),
    outputClosed: Deferred.await(closed),
    isOutputClosed: Deferred.isDone(closed),
    write: (text: string) =>
      Effect.suspend(() =>
        Deferred.isDoneUnsafe(closed)
          ? Effect.void
          : terminal.display(text).pipe(Effect.catch(() => Effect.asVoid(Deferred.succeed(closed, undefined)))),
      ),
  }
})
