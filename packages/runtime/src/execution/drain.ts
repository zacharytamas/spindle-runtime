import type { AttachmentRef, QueueMessageInput } from "@standardagents/spec"
import { Effect } from "effect"
import { Registry } from "../registry/Registry.ts"
import type { NewMessage, Queued } from "../store/model.ts"
import { RunStore } from "../store/RunStore.ts"
import { commitMessage } from "./messages.ts"
import { mapStrings } from "./redact.ts"
import type { SideScope, ThreadScope } from "./step.ts"
import { callStarted, completeCall, hookCall } from "./tool-lifecycle.ts"
import { executeTool, failed, type ToolCall } from "./tools.ts"
import { type AgentSides, isFunctionTool, otherSide, roleOf } from "./turn.ts"

// Messages section 4: a queued message is stored with its own perspective and payload. Admission let only attachment
// references through.
const draftOf = (input: QueueMessageInput): NewMessage => ({
  role: input.role,
  content: input.content,
  status: "completed",
  ...(input.silent === undefined ? {} : { silent: input.silent }),
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  ...((input.attachments ?? []).length === 0 ? {} : { attachments: input.attachments as Array<AttachmentRef> }),
})

// Threads section 3.1: a queued tool runs without a model response that asks for it. Spindle stores it as a
// call of the prompt side with its result after it, so the next request shows both, and marks the call queued.
const runQueuedTool = (side: SideScope, thread: ThreadScope, entry: Queued & { readonly kind: "tool" }) =>
  Effect.gen(function* () {
    const registry = yield* Registry
    const { turn, toolContext, write } = side
    const { record, observe, redact } = thread
    const definition = registry.definitions.find(
      (candidate) => candidate.kind === "tool" && candidate.qualifiedName === entry.toolName,
    )
    const tool = isFunctionTool(definition) ? definition : undefined
    const exposed = [...turn.tools.values()].find((candidate) => candidate.tool === definition)
    const name = exposed?.name ?? definition?.name ?? entry.toolName
    const argumentsText = JSON.stringify(mapStrings(entry.args, redact, redact))
    const call: ToolCall = {
      id: `queued-${crypto.randomUUID()}`,
      name,
      arguments: { ...entry.args },
      argumentsText,
      problem: tool === undefined ? `The queued tool ${entry.toolName} is no longer defined` : undefined,
    }
    const { message, seq } = yield* commitMessage(
      write,
      {
        role: roleOf(turn.side),
        content: null,
        tool_calls: JSON.stringify([hookCall(call, argumentsText)]),
        status: "completed",
        metadata: { queued: true },
      },
      {
        dequeue: entry.seq,
        resultPrompt: turn.prompt.qualifiedName,
        finish: (message) => ({
          ...message,
          tool_calls: JSON.stringify([
            hookCall(call, JSON.stringify(mapStrings(JSON.parse(argumentsText), redact, redact))),
          ]),
        }),
      },
    )
    yield* record("drain", `tool ${name} ${call.id}`)
    yield* observe({ type: "message", message })
    yield* callStarted(write.hooks, call)
    yield* completeCall(
      side,
      thread,
      seq,
      call,
      tool === undefined
        ? Effect.succeed(failed(call.problem ?? ""))
        : executeTool(toolContext, tool, exposed?.entry, entry.args),
    )
    return seq
  })

// The automated peer delivers messages for a human. Until tools carry an explicit
// owner, the first prompt side takes an unassigned queued tool (design rule 28).
export function queueRecipient(sides: AgentSides, entry: Queued | undefined) {
  if (entry?.kind !== "message") return sides.a.kind === "prompt" ? sides.a : sides.b
  const target = entry.message.role === "user" ? sides.a : sides.b
  return target.kind === "human" ? sides[otherSide(target.side)] : target
}

// Runtime section 3 step 1 and section 9: queued work enters in arrival order, one entry at a time, and each entry
// leaves the queue in the transaction that stores what it delivers. The result says whether the prompt side got
// something to act on: a queued tool, or a message from the other side's perspective.
export const drainQueue = Effect.fnUntraced(function* (side: SideScope, thread: ThreadScope) {
  const { record, observe, run, delivery } = thread
  const runStore = yield* RunStore
  let first: number | undefined
  let prompted = false
  while (!run.stopAtBoundary()) {
    const entry = yield* runStore.nextQueued(delivery.threadId, { flowId: run.flowId })
    if (entry === undefined || queueRecipient(thread.sides, entry).side !== side.turn.side) break
    if (entry.kind === "tool") {
      const seq = yield* runQueuedTool(side, thread, entry)
      first ??= seq
      prompted = true
      continue
    }
    const { message, seq } = yield* commitMessage(delivery, draftOf(entry.message), { dequeue: entry.seq })
    first ??= seq
    yield* record("drain", `message ${message.id}`)
    yield* observe({ type: "message", message })
    if (message.role !== roleOf(side.turn.side)) prompted = true
  }
  if (first === undefined) yield* record("drain", "none")
  return { prompted, first }
})
