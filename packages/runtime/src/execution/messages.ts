import type { Message, MessageUpdates } from "@standardagents/spec"
import { Effect, Predicate } from "effect"
import { nowMicros } from "../store/database.ts"
import { MessageStore } from "../store/MessageStore.ts"
import type { NewMessage, WriteOrigin } from "../store/model.ts"
import type { Secrets } from "./env.ts"
import type { History } from "./history.ts"
import {
  type HookCall,
  HookFailed,
  type HookScope,
  NestedWriteLimit,
  NestedWriteTooDeep,
  observeHooks,
  TEXT_FIELDS,
  transformHooks,
  vetoHooks,
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
  readonly callerSeq?: number
  readonly origin: WriteOrigin
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
  if (field === "metadata") return Predicate.isObject(value) ? redactMetadata(value, redact, result) : value
  if (field === "attachments")
    return Array.isArray(value)
      ? value.map((item) => (Predicate.isObject(item) ? redactAttachment(item, redact) : item))
      : value
  return typeof value === "string" ? redact(value) : value
}

interface WritePolicy {
  readonly fields?: ReadonlyArray<(typeof FIELDS)[number]>
  readonly keepErrorCode?: boolean
  readonly finish?: (message: Message) => Message
  readonly resultPrompt?: string
  readonly dequeue?: number
}

const secretId = "returned an id that holds a secret value"

const prepareWrite = Effect.fnUntraced(function* <E>(
  write: WriteContext,
  draft: NewMessage,
  policy: WritePolicy,
  before: (...args: Parameters<typeof transformHooks<"before_create_message">>) => Effect.Effect<Message, E>,
  taken?: (id: string) => Effect.Effect<boolean>,
) {
  const store = yield* MessageStore
  const depth = yield* depthOf(write)
  const original = messageOf(draft, crypto.randomUUID(), yield* nowMicros)
  const redact = redactor(write.secrets.values)
  let owner: string | undefined
  const check = Effect.fnUntraced(function* (next: Message, current: Message, hook: string) {
    if (next.id === current.id) return
    if (redact(next.id) !== next.id) return secretId
    if (taken && (yield* taken(next.id))) return "returned the id of a message that already exists"
    owner = hook
  })
  const hooked = yield* before(write.hooks, "before_create_message", [], original, { depth, check })
  const replacements: Record<string, unknown> = {}
  for (const field of FIELDS)
    if (policy.fields?.includes(field) || !sameJson(original[field], hooked[field]))
      replacements[field] = redactField(field, hooked[field], redact, policy.keepErrorCode === true)
  const redacted = { ...hooked, ...replacements }
  const message = policy.finish ? policy.finish(redacted) : redacted
  const unsafeId = hooked.id !== original.id && redact(hooked.id) !== hooked.id ? owner : undefined
  const insert = (id: string) =>
    store.insertMessage(write.threadId, { ...message, id }, write.origin, {
      callerSeq: write.callerSeq,
      dequeue: policy.dequeue,
      resultPrompt: policy.resultPrompt,
    })
  const after = Effect.fnUntraced(function* (inserted: Parameters<History["inserted"]>[0]) {
    write.history?.inserted(inserted)
    yield* observeHooks(write.hooks, "after_create_message", [inserted.message], { depth })
    return inserted
  })
  return { original, message, unsafeId, insert, after, redact }
})

export const injectMessage = Effect.fn("injectMessage")(function* (write: WriteContext, draft: NewMessage) {
  const { message, unsafeId, insert, after } = yield* prepareWrite(
    write,
    draft,
    { fields: ["content", "metadata"] },
    vetoHooks<"before_create_message">,
  )
  if (unsafeId !== undefined)
    return yield* new HookFailed({ hook: unsafeId, position: "before_create_message", problem: secretId })
  return yield* after(yield* insert(message.id))
})

export const commitMessage = Effect.fn("commitMessage")(function* (
  write: WriteContext,
  draft: NewMessage,
  policy: WritePolicy = {},
) {
  const store = yield* MessageStore
  const { original, message, unsafeId, insert, after, redact } = yield* prepareWrite(
    write,
    draft,
    policy,
    transformHooks<"before_create_message">,
    (id) => store.messageIdTaken(id).pipe(Effect.orDie),
  )
  let id = message.id
  if (unsafeId !== undefined) {
    yield* Effect.logWarning(`Hook ${unsafeId} (before_create_message) ${secretId}. Spindle kept the generated id.`)
    id = original.id
  }
  // A nested write can take a checked id. Retry the insert once without replaying a hook's side effects.
  const inserted = yield* insert(id).pipe(
    Effect.catchTag("MessageIdTaken", (error) => {
      const fresh = crypto.randomUUID()
      return Effect.logWarning(
        `Message id ${JSON.stringify(redact(error.messageId))} was taken when Spindle stored the message, so Spindle stored it once under the id ${fresh}.`,
      ).pipe(Effect.andThen(insert(fresh)))
    }),
  )
  return yield* after(inserted)
})

// Threads section 2.3: text that user code writes is redacted before it is stored, as tool output is.
const redactUpdates = (updates: Record<string, unknown>, redact: (text: string) => string) => ({
  ...updates,
  ...(typeof updates.content === "string" ? { content: redact(updates.content) } : {}),
  ...(Predicate.isObject(updates.metadata) ? { metadata: redactMetadata(updates.metadata, redact) } : {}),
})

// Hooks sections 4.3 and 4.4. A failed before_update_message hook refuses the update. The patch is redacted once,
// after the hooks.
export const updateMessage = Effect.fn("updateMessage")(function* (
  write: WriteContext,
  messageId: string,
  updates: MessageUpdates,
) {
  const store = yield* MessageStore
  const depth = yield* depthOf(write)
  const patch = yield* vetoHooks(write.hooks, "before_update_message", [messageId], { ...updates }, { depth })
  const redacted = redactUpdates(patch, redactor(write.secrets.values))
  const message = yield* store.updateMessage(write.threadId, messageId, redacted as MessageUpdates, write.origin)
  yield* observeHooks(write.hooks, "after_update_message", [message], { depth })
  return message
})
