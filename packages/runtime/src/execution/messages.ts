import type { Message, MessageUpdates } from "@standardagents/spec"
import { Clock, Effect } from "effect"
import { type NewMessage, ThreadStore } from "../store/ThreadStore.ts"
import type { Secrets } from "./env.ts"
import type { History } from "./history.ts"
import {
  type HookCall,
  HookFailed,
  type HookScope,
  NestedWriteLimit,
  NestedWriteTooDeep,
  runHooks,
  TEXT_FIELDS,
} from "./hooks.ts"
import { mapStrings, redactor } from "./redact.ts"
import { redactAttachment } from "./tools.ts"

export interface WriteContext {
  readonly threadId: string
  readonly hooks: HookScope
  readonly secrets: Secrets
  // The hook call whose ThreadState writes, when a hook writes.
  readonly call: HookCall | undefined
  // The history of the execution that writes, when an execution writes.
  readonly history: History | undefined
  // The flow of the execution that writes. Its writes fail once that flow no longer holds the thread.
  readonly callerSeq?: number
  readonly flowId?: string
}

// A write from a hook is one level deeper than the write or the step that called the hook.
const depthOf = Effect.fnUntraced(function* (write: WriteContext) {
  const { call } = write
  if (call === undefined) return 0
  const limit = yield* NestedWriteLimit
  if (call.depth > limit) {
    const error = new NestedWriteTooDeep({ hook: call.hook, position: call.position, depth: call.depth, limit })
    // Every hook above this write sees only that its own write failed, so this is the one line that says why.
    yield* Effect.logWarning(error.message)
    return yield* error
  }
  return call.depth
})

const nowMicros = Effect.map(Clock.currentTimeNanos, (nanos) => Number(nanos / 1000n))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Hooks section 4.1: before_create_message sees the whole record that the store will hold, its id and time included.
const messageOf = (draft: NewMessage, id: string, created_at: number): Message => ({
  id,
  role: draft.role,
  content: draft.content ?? null,
  name: draft.name ?? null,
  tool_calls: draft.tool_calls ?? null,
  tool_call_id: draft.tool_call_id ?? null,
  tool_status: draft.tool_status ?? null,
  status: draft.status ?? null,
  attachments: draft.attachments ?? null,
  reasoning_content: draft.reasoning_content ?? null,
  reasoning_details: draft.reasoning_details ?? null,
  prompt: draft.prompt ?? null,
  created_at,
  parent_id: draft.parent_id ?? null,
  depth: draft.depth ?? 0,
  silent: draft.silent === true,
  metadata: draft.metadata ?? {},
  subagent_id: null,
  subagent_relationship: null,
  subagent_name: null,
  subagent_title: null,
  subagent_description: null,
  subagent_status: null,
  subagent_blocking: null,
  subagent_thread_name: null,
  subagent_spawn_group_id: null,
})

const sameJson = (a: unknown, b: unknown) => {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

// Who wrote a message decides what redaction changes. Text that a tool or a hook wrote loses each secret, and the
// human's message and the model's response keep theirs. A field that a hook changes is the hook's text either way.
// An injection is a write its caller may refuse. A tool result and a turn are writes the execution needs. A queued
// call is the call that a tool or a hook queued, whose arguments that code wrote.
export type Writer = "injection" | "result" | "turn" | "queued" | "skipped"

const WRITTEN: { readonly [W in Writer]: ReadonlyArray<string> } = {
  injection: ["content", "metadata"],
  skipped: ["content", "metadata", "attachments"],
  result: ["content", "metadata", "attachments"],
  turn: [],
  queued: [],
}

const FIELDS = [...TEXT_FIELDS, "metadata", "attachments"] as const

// Threads section 2.3. error_code and error_data are the keys Spindle stores a tool result's error under, so they keep
// their names. A tool result's own error code is an identifier that the runtime and clients read back, so that one
// string keeps its value too. Everything else under either key is redacted.
export const redactMetadata = (metadata: Record<string, unknown>, redact: (text: string) => string, result = false) =>
  Object.fromEntries(
    Object.entries(metadata).map(([key, value]) =>
      result && key === "error_code" && typeof value === "string"
        ? [key, value]
        : [key === "error_code" || key === "error_data" ? key : redact(key), mapStrings(value, redact, redact)],
    ),
  )

const redactField = (
  field: (typeof FIELDS)[number],
  value: unknown,
  redact: (text: string) => string,
  result: boolean,
) => {
  if (field === "metadata") return isRecord(value) ? redactMetadata(value, redact, result) : value
  if (field === "attachments")
    return Array.isArray(value) ? value.map((item) => (isRecord(item) ? redactAttachment(item, redact) : item)) : value
  return typeof value === "string" ? redact(value) : value
}

const redactWrite = (writer: Writer, before: Message, after: Message, redact: (text: string) => string): Message => {
  const redacted: Record<string, unknown> = {}
  for (const field of FIELDS)
    if (WRITTEN[writer].includes(field) || !sameJson(before[field], after[field]))
      redacted[field] = redactField(field, after[field], redact, writer === "result")
  return { ...after, ...redacted }
}

// Hooks section 4.1 and 4.2. A write that the caller may refuse, such as injectMessage, fails when a
// before_create_message hook fails, and fails with MessageIdTaken when the hooks chose an id that a message holds.
// A write the execution cannot go on without fails only the hook that went wrong, a hook that chose a taken id
// included: the next hook gets the message from before it, and the last good message is stored.
// Redaction is the last step before the store, so that it uses every secret the hooks learned.
export const createMessage = Effect.fn("createMessage")(function* (
  write: WriteContext,
  draft: NewMessage,
  writer: Writer,
  // The queue entry that this message delivers, removed when the message is stored.
  dequeue?: number,
) {
  const store = yield* ThreadStore
  const depth = yield* depthOf(write)
  const essential = writer !== "injection"
  const original = messageOf(draft, crypto.randomUUID(), yield* nowMicros)
  // An id is stored and printed as it is, so redaction cannot reach it, and a hook may not choose one that holds a
  // secret value.
  const redact = redactor(write.secrets.values)
  let idOwner: string | undefined
  const check = Effect.fnUntraced(function* (next: Message, current: Message, hook: string) {
    if (next.id === current.id) return
    if (redact(next.id) !== next.id) return "returned an id that holds a secret value"
    if (essential && (yield* store.messageIdTaken(next.id).pipe(Effect.orDie)))
      return "returned the id of a message that already exists"
    idOwner = hook
  })
  const hooked = yield* runHooks(write.hooks, "before_create_message", [], original, { depth, essential, check })
  let redacted = redactWrite(writer, original, hooked, redact)
  if (writer === "skipped") redacted = {...redacted, role: original.role, name: original.name, tool_call_id: original.tool_call_id, tool_status: "error", content: original.content}
  if (idOwner !== undefined && hooked.id !== original.id && redact(hooked.id) !== hooked.id) {
    const problem = "returned an id that holds a secret value"
    if (!essential) return yield* new HookFailed({ hook: idOwner, position: "before_create_message", problem })
    yield* Effect.logWarning(`Hook ${idOwner} (before_create_message) ${problem}. Spindle kept the generated id.`)
    redacted = { ...redacted, id: original.id }
  }
  const options =
    write.flowId === undefined
      ? {}
      : {
          ...(write.callerSeq === undefined ? {} : { callerSeq: write.callerSeq }),
          flowId: write.flowId,
          ...(dequeue === undefined ? {} : { dequeue }),
        }
  // A hook's own nested write can take the id after the check above passed it. A write the execution needs is
  // stored once under an id from the runtime, and its hooks, which have already run, do not run again.
  const inserted = yield* store.insertMessage(write.threadId, redacted, options).pipe(
    Effect.catchTag("MessageIdTaken", (error) => {
      if (!essential) return Effect.fail(error)
      const id = crypto.randomUUID()
      return Effect.logWarning(
        `Message id ${JSON.stringify(redact(error.messageId))} was taken when Spindle stored the message, so Spindle stored it once under the id ${id}.`,
      ).pipe(Effect.andThen(store.insertMessage(write.threadId, { ...redacted, id }, options)))
    }),
  )
  write.history?.inserted(inserted)
  const stored = inserted.message
  yield* runHooks(write.hooks, "after_create_message", [], stored, { depth })
  return stored
})

// Threads section 2.3: text that user code writes is redacted before it is stored, as tool output is.
const redactUpdates = (updates: Record<string, unknown>, redact: (text: string) => string) => ({
  ...updates,
  ...(typeof updates.content === "string" ? { content: redact(updates.content) } : {}),
  ...(isRecord(updates.metadata) ? { metadata: redactMetadata(updates.metadata, redact) } : {}),
})

// Hooks sections 4.3 and 4.4. A failed before_update_message hook refuses the update. The patch is redacted once,
// after the hooks.
export const updateMessage = Effect.fn("updateMessage")(function* (
  write: WriteContext,
  messageId: string,
  updates: MessageUpdates,
) {
  const store = yield* ThreadStore
  const depth = yield* depthOf(write)
  const patch = yield* runHooks(write.hooks, "before_update_message", [messageId], { ...updates }, { depth })
  const redacted = redactUpdates(patch, redactor(write.secrets.values))
  const message = yield* store.updateMessage(write.threadId, messageId, redacted as MessageUpdates)
  yield* runHooks(write.hooks, "after_update_message", [], message, { depth })
  return message
})
