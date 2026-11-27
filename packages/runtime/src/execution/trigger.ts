import { Effect } from "effect"
import { ThreadStore } from "../store/ThreadStore.ts"
import { type ExecutionOptions, runExecution } from "./step.ts"
import { roleOf, sidesOf } from "./turn.ts"

// Runtime section 2: a message from the human side starts an execution of the prompt side. M1-6 queues the
// message instead when the thread is already executing.
export const sendMessage = (threadId: string, content: string, options: ExecutionOptions = {}) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    const thread = yield* store.getThread(threadId)
    const { human } = yield* sidesOf(thread.agentId)
    const [message] = yield* store.appendMessages(threadId, [{ role: roleOf(human), content, status: "completed" }])
    if (message !== undefined && options.observe !== undefined) yield* options.observe({ type: "message", message })
    return yield* runExecution(threadId, options)
  })
