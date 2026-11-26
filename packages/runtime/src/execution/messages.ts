import type { Message, MessageUpdates } from "@standardagents/spec"
import { Clock, Effect } from "effect"
import { type NewMessage, ThreadStore } from "../store/ThreadStore.ts"
import type { Secrets } from "./env.ts"
import { type HookScope, runHooks, TEXT_FIELDS } from "./hooks.ts"
import { mapStrings, redactor } from "./redact.ts"
import { redactAttachment } from "./tools.ts"

export interface WriteContext {
  readonly threadId: string
  readonly hooks: HookScope
  readonly secrets: Secrets
}

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
// An injection is a write its caller may refuse. A tool result and a turn are writes the execution needs.
export type Writer = "injection" | "result" | "turn"

const WRITTEN: { readonly [W in Writer]: ReadonlyArray<string> } = {
  injection: ["content", "metadata"],
  result: ["content", "metadata", "attachments"],
  turn: [],
}

const FIELDS = [...TEXT_FIELDS, "metadata", "attachments"] as const

// Threads section 2.3. error_code and error_data are the keys Spindle stores a tool result's error under, so they keep
// their names, and the error code is an identifier that the runtime reads back, so it keeps its value too.
const redactMetadata = (metadata: Record<string, unknown>, redact: (text: string) => string) =>
  Object.fromEntries(
    Object.entries(metadata).map(([key, value]) =>
      key === "error_code"
        ? [key, value]
        : [key === "error_data" ? key : redact(key), mapStrings(value, redact, redact)],
    ),
  )

const redactField = (field: (typeof FIELDS)[number], value: unknown, redact: (text: string) => string) => {
  if (field === "metadata") return isRecord(value) ? redactMetadata(value, redact) : value
  if (field === "attachments")
    return Array.isArray(value) ? value.map((item) => (isRecord(item) ? redactAttachment(item, redact) : item)) : value
  return typeof value === "string" ? redact(value) : value
}

const redactWrite = (writer: Writer, before: Message, after: Message, redact: (text: string) => string): Message => {
  const redacted: Record<string, unknown> = {}
  for (const field of FIELDS)
    if (WRITTEN[writer].includes(field) || !sameJson(before[field], after[field]))
      redacted[field] = redactField(field, after[field], redact)
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
) {
  const store = yield* ThreadStore
  const essential = writer !== "injection"
  const original = messageOf(draft, crypto.randomUUID(), yield* nowMicros)
  const taken = (next: Message, current: Message) =>
    next.id === current.id
      ? Effect.succeed(undefined)
      : store.messageIdTaken(next.id).pipe(
          Effect.map((found) => (found ? "returned the id of a message that already exists" : undefined)),
          Effect.orDie,
        )
  const hooked = yield* runHooks(
    write.hooks,
    "before_create_message",
    [],
    original,
    essential ? { essential, check: taken } : {},
  )
  const stored = yield* store.insertMessage(
    write.threadId,
    redactWrite(writer, original, hooked, redactor(write.secrets.values)),
  )
  yield* runHooks(write.hooks, "after_create_message", [], stored)
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
  const patch = yield* runHooks(write.hooks, "before_update_message", [messageId], { ...updates })
  const redacted = redactUpdates(patch, redactor(write.secrets.values))
  const message = yield* store.updateMessage(write.threadId, messageId, redacted as MessageUpdates)
  yield* runHooks(write.hooks, "after_update_message", [], message)
  return message
})
