import type { AttachmentRef, QueueMessageInput } from "@standardagents/spec"
import { Effect } from "effect"
import { Registry } from "../registry/Registry.ts"
import type { NewMessage, Queued } from "../store/model.ts"
import { RunStore } from "../store/RunStore.ts"
import { commitMessage, type WriteContext } from "./messages.ts"
import { mapStrings, redactor } from "./redact.ts"
import type { StepEvents } from "./step.ts"
import { callStarted, completeCall, hookCall } from "./tool-lifecycle.ts"
import { executeTool, failed, type ToolCall, type ToolContext } from "./tools.ts"
import { isFunctionTool, roleOf } from "./turn.ts"

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
const runQueuedTool = (
  toolContext: ToolContext,
  write: WriteContext,
  events: StepEvents,
  entry: Queued & { readonly kind: "tool" },
) =>
  Effect.gen(function* () {
    const registry = yield* Registry
    const { turn } = toolContext
    const { record, observe } = events
    const redact = redactor(write.secrets.values)
    const definition = registry.definitions.find(
      (candidate) => candidate.kind === "tool" && candidate.qualifiedName === entry.toolName,
    )
    const value = definition === undefined ? undefined : registry.loaded.get(definition)
    const tool = definition !== undefined && isFunctionTool(value) ? { definition, value } : undefined
    const exposed = [...turn.tools.values()].find((candidate) => candidate.tool.definition === definition)
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
        prompt: turn.prompt.definition.qualifiedName,
        status: "completed",
        metadata: { queued: true },
      },
      {
        dequeue: entry.seq,
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
      toolContext,
      write,
      events,
      seq,
      call,
      tool === undefined
        ? Effect.succeed(failed(call.problem ?? ""))
        : executeTool(toolContext, tool, exposed?.entry, entry.args),
    )
    return message.id
  })
// Runtime section 3 step 1 and section 9: queued work enters in arrival order, one entry at a time, and each entry
// leaves the queue in the transaction that stores what it delivers. The result says whether the prompt side got
// something to act on: a queued tool, or a message from the other side's perspective.
export const drainQueue = Effect.fnUntraced(function* (
  toolContext: ToolContext,
  write: WriteContext,
  delivery: WriteContext,
  events: StepEvents,
) {
  const { record, observe } = events
  const { execution: run, turn } = toolContext
  const runStore = yield* RunStore
  let first: string | undefined
  let prompted = false
  let count = 0
  while (!run.stopAtBoundary()) {
    const entry = yield* runStore.nextQueued(write.threadId, { flowId: run.flowId })
    if (entry === undefined) break
    count += 1
    if (entry.kind === "tool") {
      const id = yield* runQueuedTool(toolContext, write, events, entry)
      first ??= id
      prompted = true
      continue
    }
    const { message } = yield* commitMessage(delivery, draftOf(entry.message), { dequeue: entry.seq })
    first ??= message.id
    yield* record("drain", `message ${message.id}`)
    yield* observe({ type: "message", message })
    if (message.role !== roleOf(turn.side)) prompted = true
  }
  if (count === 0) yield* record("drain", "none")
  return { prompted, first, count }
})
