import type { Message, MessageUpdates } from "@standardagents/spec"
import { Clock, Effect } from "effect"
import { type NewMessage, ThreadStore } from "../store/ThreadStore.ts"
import type { Secrets } from "./env.ts"
import { type HookScope, runHooks, TEXT_FIELDS } from "./hooks.ts"
import { mapStrings, redactor, redactText } from "./redact.ts"
import { redactAttachment } from "./tools.ts"

export interface WriteContext {
  readonly threadId: string
  readonly hooks: HookScope
  readonly secrets: Secrets
  // The live history of the execution that writes, when an execution writes.
  readonly history: Array<Message> | undefined
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

// A hook is code the developer wrote, so a field it changed is redacted like tool output, as the last step before
// the store. A field that the human, the model, or the runtime wrote keeps its value.
const redactChanged = (before: Message, after: Message, redact: (text: string) => string): Message => {
  const changed: Record<string, unknown> = {}
  for (const field of TEXT_FIELDS) {
    const value = after[field]
    if (typeof value === "string" && value !== before[field]) changed[field] = redactText(redact)(value)
  }
  if (!sameJson(before.metadata, after.metadata) && isRecord(after.metadata))
    changed.metadata = mapStrings(after.metadata, redact)
  if (!sameJson(before.attachments, after.attachments) && Array.isArray(after.attachments))
    changed.attachments = after.attachments.map((item: unknown) =>
      isRecord(item) ? redactAttachment(item, redact) : item,
    )
  return { ...after, ...changed }
}

// Hooks section 4.1 and 4.2. A write that the caller may refuse, such as injectMessage, fails when a
// before_create_message hook fails. A write the execution cannot go on without stores the last good message.
export const createMessage = Effect.fn("createMessage")(function* (
  write: WriteContext,
  draft: NewMessage,
  essential: boolean,
) {
  const store = yield* ThreadStore
  const original = messageOf(draft, crypto.randomUUID(), yield* nowMicros)
  const hooked = yield* runHooks(write.hooks, "before_create_message", [], original, { essential })
  const insert = (message: Message) => store.insertMessage(write.threadId, message)
  const stored =
    hooked === original
      ? yield* insert(original)
      : yield* insert(redactChanged(original, hooked, redactor(write.secrets.values))).pipe(
          Effect.catchTag(["ValueNotJson", "MessageIdTaken"], (error) =>
            essential
              ? Effect.logWarning(
                  `The before_create_message hooks returned a message that the store refused (${error._tag}). Spindle stored the message without their changes.`,
                ).pipe(Effect.andThen(insert(original)))
              : Effect.fail(error),
          ),
        )
  write.history?.push(stored)
  yield* runHooks(write.hooks, "after_create_message", [], stored)
  return stored
})

// Threads section 2.3: text that user code writes is redacted before it is stored, as tool output is.
const redactUpdates = (updates: Record<string, unknown>, redact: (text: string) => string) => ({
  ...updates,
  ...(typeof updates.content === "string" ? { content: redactText(redact)(updates.content) } : {}),
  ...(isRecord(updates.metadata) ? { metadata: mapStrings(updates.metadata, redact) } : {}),
})

// Hooks sections 4.3 and 4.4. A failed before_update_message hook refuses the update.
export const updateMessage = Effect.fn("updateMessage")(function* (
  write: WriteContext,
  messageId: string,
  updates: MessageUpdates,
) {
  const store = yield* ThreadStore
  const redact = redactor(write.secrets.values)
  const patch = yield* runHooks(
    write.hooks,
    "before_update_message",
    [messageId],
    redactUpdates({ ...updates }, redact),
  )
  const message = yield* store.updateMessage(write.threadId, messageId, redactUpdates(patch, redact) as MessageUpdates)
  const index = write.history?.findIndex((candidate) => candidate.id === messageId) ?? -1
  if (write.history !== undefined && index !== -1) write.history[index] = message
  yield* runHooks(write.hooks, "after_update_message", [], message)
  return message
})
