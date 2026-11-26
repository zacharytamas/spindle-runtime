// A model whose answers follow fixed rules and whose calls wait on files, so that a test in another process decides
// when a call returns. SPINDLE_GATE_DIR names the folder. The provider writes request-<pid>-<n>.json for each request.
// While hold-model exists, it writes model-entered-<pid>-<n> and waits for release-model.
// A last user message "call:<JSON array of { name, arguments }>" asks for those tool calls, a last tool message gets
// "done", and anything else gets "ack: " and the texts of the trailing user messages.
import fs from "node:fs"
import path from "node:path"
import { defineModel, type LLMProviderInterface, type ProviderRequest } from "@standardagents/spec"

const gate = () => {
  const dir = process.env.SPINDLE_GATE_DIR
  if (dir === undefined) throw new Error("SPINDLE_GATE_DIR is not set")
  return dir
}

const wait = async (file: string, signal: AbortSignal | undefined) => {
  while (!fs.existsSync(file)) {
    if (signal?.aborted === true) throw new Error("the request was aborted")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

let count = 0

const textOf = (content: unknown) => (typeof content === "string" ? content : JSON.stringify(content))

const answer = (request: ProviderRequest) => {
  const history = request.messages.filter((message) => message.role !== "system")
  const last = history.at(-1)
  if (last?.role === "tool") return { text: "done", calls: [] }
  if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("call:")) {
    const calls = JSON.parse(last.content.slice("call:".length)) as Array<{ name: string; arguments: object }>
    return { text: null, calls }
  }
  const trailing: Array<string> = []
  for (let index = history.length - 1; index >= 0 && history[index]?.role === "user"; index--)
    trailing.unshift(textOf(history[index]?.content))
  return { text: `ack: ${trailing.join(" | ")}`, calls: [] }
}

const provider: LLMProviderInterface = {
  name: "gated",
  specificationVersion: "1",
  stream: async (request) => {
    count += 1
    const n = count
    const dir = gate()
    const { signal, ...recorded } = request
    fs.writeFileSync(path.join(dir, `request-${process.pid}-${n}.json`), JSON.stringify(recorded))
    if (fs.existsSync(path.join(dir, "hold-model"))) {
      fs.writeFileSync(path.join(dir, `model-entered-${process.pid}-${n}`), String(signal?.aborted ?? false))
      await wait(path.join(dir, "release-model"), signal)
      fs.writeFileSync(path.join(dir, `model-left-${process.pid}-${n}`), String(signal?.aborted ?? false))
    }
    const { text, calls } = answer(request)
    return (async function* () {
      if (text !== null) yield { type: "content-delta" as const, delta: text }
      for (const [index, call] of calls.entries()) {
        const id = `call-${process.pid}-${n}-${index}`
        yield { type: "tool-call-start" as const, id, name: call.name }
        yield { type: "tool-call-delta" as const, id, argumentsDelta: JSON.stringify(call.arguments) }
        yield { type: "tool-call-done" as const, id, arguments: call.arguments as Record<string, unknown> }
      }
      yield {
        type: "finish" as const,
        finishReason: calls.length > 0 ? ("tool_calls" as const) : ("stop" as const),
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }
    })()
  },
  generate: async () => {
    throw new Error("The gated model only streams")
  },
}

export default defineModel({
  name: "gated",
  provider: () => provider,
  model: "gated-v1",
})
