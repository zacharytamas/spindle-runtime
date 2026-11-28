import type { AttachmentRef, QueueMessageInput } from "@standardagents/spec"
import { Effect } from "effect"
import { Registry } from "../registry/Registry.ts"
import { MessageStore } from "../store/MessageStore.ts"
import type { NewMessage, Queued } from "../store/model.ts"
import { RunStore } from "../store/RunStore.ts"
import { commitMessage } from "./messages.ts"
import { mapStrings } from "./redact.ts"
import type { SideScope, ThreadScope, ToolScope } from "./step.ts"
import { callStarted, completeCall, hookCall } from "./tool-lifecycle.ts"
import { executeTool, failed, learnToolVariables, scopeFor, type ToolCall } from "./tools.ts"
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

// Synthetic calls use the owning side’s role and hooks. A handler has no result prompt.
export const runQueuedTool = (side: ToolScope, thread: ThreadScope, entry: Queued & { readonly kind: "tool" }) =>
  Effect.gen(function* () {
    const registry = yield* Registry
    const { turn, toolContext, write } = side
    const { record, observe, redact } = thread
    const definition = registry.definitions.find(
      (candidate) => candidate.kind === "tool" && candidate.qualifiedName === entry.toolName,
    )
    const tool = isFunctionTool(definition) ? definition : undefined
    const exposed =
      turn.kind === "prompt" ? [...turn.tools.values()].find((candidate) => candidate.tool === definition) : undefined
    const name = exposed?.name ?? definition?.name ?? entry.toolName
    if (tool !== undefined) yield* learnToolVariables(scopeFor(turn, exposed?.entry), tool, thread.secrets)
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
        ...(turn.kind === "prompt" && { resultPrompt: turn.prompt.qualifiedName }),
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
  })

// A tool queued at rest belongs to the first prompt side, or the first handler if there is no prompt.
export function queueRecipient(sides: AgentSides, entry: Queued | undefined) {
  if (entry?.kind === "tool" && entry.side && sides[entry.side].kind !== "human") return sides[entry.side]
  if (entry?.kind !== "message") {
    if (sides.a.kind === "prompt") return sides.a
    return sides.b.kind === "prompt" || sides.a.kind === "human" ? sides.b : sides.a
  }
  const target = entry.message.role === "user" ? sides.a : sides.b
  return target.kind === "human" ? sides[otherSide(target.side)] : target
}

export const deliverQueued = Effect.fnUntraced(function* (
  thread: ThreadScope,
  entry: Queued & { kind: "message" },
  deliveredTo?: "a" | "b",
) {
  const { message } = yield* commitMessage(thread.delivery, draftOf(entry.message), {
    dequeue: entry.seq,
    ...(deliveredTo && { deliveredTo }),
  })
  yield* thread.record("drain", `message ${message.id}`)
  const current = deliveredTo ? yield* (yield* MessageStore).getMessage(thread.thread.id, message.id) : message
  if (!current) return undefined
  yield* thread.observe({ type: "message", message: current })
  return current
})

// Runtime section 3 step 1 and section 9: queued work enters in arrival order, one entry at a time, and each entry
// leaves the queue in the transaction that stores what it delivers. The result says whether the prompt side got
// something to act on: a queued tool, or a message from the other side's perspective.
export const drainQueue = Effect.fnUntraced(function* (side: SideScope, thread: ThreadScope) {
  const { record, run, delivery } = thread
  const runStore = yield* RunStore
  let drained = false
  let prompted = false
  while (!run.stopAtBoundary()) {
    const entry = yield* runStore.nextQueued(delivery.threadId, { flowId: run.flowId })
    if (entry === undefined || entry.kind === "agent" || queueRecipient(thread.sides, entry).side !== side.turn.side)
      break
    drained = true
    if (entry.kind === "tool") {
      yield* runQueuedTool(side, thread, entry)
      prompted = true
      continue
    }
    const message = yield* deliverQueued(thread, entry)
    if (message && message.role !== roleOf(side.turn.side)) prompted = true
  }
  if (!drained) yield* record("drain", "none")
  return prompted
})
