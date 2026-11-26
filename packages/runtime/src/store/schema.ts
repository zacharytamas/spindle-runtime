import type { AttachmentRef, Message, QueueMessageInput, ThreadStatus } from "@standardagents/spec"
import { Option, Schema } from "effect"
import type { NewMessage, Queued, QueueEntry, Thread } from "./model.ts"

type Text = string | Uint8Array

// The default decoder drops a leading U+FEFF as a byte-order mark, and that character is part of the text.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true })
export function text(value: Text): string
export function text(value: Text | null): string | null
export function text(value: Text | null) {
  return value instanceof Uint8Array ? utf8.decode(value) : value
}

// With the u flag a surrogate range matches only a surrogate that is not half of a pair.
const loneSurrogates = /[\uD800-\uDFFF]/gu

// UTF-8 has no encoding for a lone surrogate, and both drivers store U+FFFD in its place. Making the
// replacement here means the record a write returns equals the record a later read returns.
export function stored(value: string): string
export function stored(value: string | null): string | null
export function stored(value: string | null) {
  return value === null ? null : value.replace(loneSurrogates, "\ufffd")
}

// node:sqlite cuts a TEXT value at its first NUL when it reads it, so such a value is read as its bytes.
const textColumn = (name: string) =>
  `CASE WHEN instr(CAST(${name} AS BLOB), x'00') > 0 THEN CAST(${name} AS BLOB) ELSE ${name} END AS ${name}`

export interface ThreadRow {
  readonly id: string
  readonly agent_id: Text
  readonly parent_id: string | null
  readonly arguments: string
  readonly created_at: number
  readonly terminated_at: number | null
  readonly run_state: ThreadStatus["state"]
  readonly run_reason: Text | null
  readonly run_since: number
}

export const threadColumns = [
  "id",
  textColumn("agent_id"),
  "parent_id",
  "arguments",
  "created_at",
  "terminated_at",
  "run_state",
  textColumn("run_reason"),
  "run_since",
].join(", ")

export const runReasonColumn = textColumn("run_reason")

export const toStatus = (row: Pick<ThreadRow, "run_state" | "run_since" | "run_reason">): ThreadStatus => ({
  state: row.run_state,
  since: row.run_since,
  reason: text(row.run_reason),
})

export const toThread = (row: ThreadRow): Thread => ({
  id: row.id,
  agentId: text(row.agent_id),
  parentId: row.parent_id,
  arguments: JSON.parse(row.arguments),
  createdAt: row.created_at,
  terminated: row.terminated_at,
  status: toStatus(row),
})

export type MessageRow = {
  readonly id: string
  readonly role: Message["role"]
  readonly content: Text | null
  readonly name: Text | null
  readonly tool_calls: Text | null
  readonly tool_call_id: Text | null
  readonly tool_status: "success" | "error" | null
  readonly status: "pending" | "completed" | "failed" | null
  readonly attachments: string | null
  readonly reasoning_content: Text | null
  readonly reasoning_details: Text | null
  readonly prompt: Text | null
  readonly created_at: number
  readonly parent_id: Text | null
  readonly depth: number
  readonly silent: 0 | 1
  readonly metadata: string
}

export const messageColumns = [
  "seq",
  "caller_seq",
  "id",
  "role",
  textColumn("content"),
  textColumn("name"),
  textColumn("tool_calls"),
  textColumn("tool_call_id"),
  "tool_status",
  "status",
  "attachments",
  textColumn("reasoning_content"),
  textColumn("reasoning_details"),
  textColumn("prompt"),
  "created_at",
  textColumn("parent_id"),
  "depth",
  "silent",
  "metadata",
].join(", ")

// M3 adds the child registry that these fields project from. Until then no message has a subagent.
const noSubagent = {
  subagent_id: null,
  subagent_relationship: null,
  subagent_name: null,
  subagent_title: null,
  subagent_description: null,
  subagent_status: null,
  subagent_blocking: null,
  subagent_thread_name: null,
  subagent_spawn_group_id: null,
} satisfies Partial<Message>

export const toMessage = (row: MessageRow): Message => ({
  id: row.id,
  role: row.role,
  content: text(row.content),
  name: text(row.name),
  tool_calls: text(row.tool_calls),
  tool_call_id: text(row.tool_call_id),
  tool_status: row.tool_status,
  status: row.status,
  attachments: row.attachments === null ? null : JSON.parse(row.attachments),
  reasoning_content: text(row.reasoning_content),
  reasoning_details: text(row.reasoning_details),
  prompt: text(row.prompt),
  created_at: row.created_at,
  parent_id: text(row.parent_id),
  depth: row.depth,
  silent: row.silent === 1,
  metadata: JSON.parse(row.metadata),
  ...noSubagent,
})

export const messageRow = (
  threadId: string,
  id: string,
  createdAt: number,
  message: NewMessage,
  json: Pick<MessageRow, "attachments" | "metadata">,
): MessageRow & { readonly thread_id: string } => ({
  thread_id: threadId,
  id,
  role: message.role,
  content: stored(message.content ?? null),
  name: stored(message.name ?? null),
  tool_calls: stored(message.tool_calls ?? null),
  tool_call_id: stored(message.tool_call_id ?? null),
  tool_status: message.tool_status ?? null,
  status: message.status ?? null,
  attachments: json.attachments,
  reasoning_content: stored(message.reasoning_content ?? null),
  reasoning_details: stored(message.reasoning_details ?? null),
  prompt: stored(message.prompt ?? null),
  created_at: createdAt,
  parent_id: stored(message.parent_id ?? null),
  depth: message.depth ?? 0,
  silent: message.silent === true ? 1 : 0,
  metadata: json.metadata,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const callsIn = (toolCalls: Text): Array<{ readonly id: string; readonly name: string }> => {
  const parsed = Option.getOrUndefined(parsePayload(text(toolCalls)))
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.id === "string"
      ? [
          {
            id: entry.id,
            name: isRecord(entry.function) && typeof entry.function.name === "string" ? entry.function.name : "",
          },
        ]
      : [],
  )
}

export interface QueueRow {
  readonly seq: number
  readonly kind: QueueEntry["kind"]
  readonly payload: string
  readonly queued_at: number
}

export const queuePayload = (entry: QueueEntry): unknown =>
  entry.kind === "message" ? entry.message : { toolName: entry.toolName, args: entry.args }

const attachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: Schema.String,
  path: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.Natural,
  width: Schema.optional(Schema.Natural),
  height: Schema.optional(Schema.Natural),
  description: Schema.optional(Schema.String),
})
const matchesAttachment = Schema.is(attachment)
export const isAttachmentRef = (value: unknown): value is AttachmentRef => matchesAttachment(value)
const record = Schema.Record(Schema.String, Schema.Unknown)
const matchesMessage = Schema.is(
  Schema.Struct({
    role: Schema.Literals(["user", "assistant"]),
    content: Schema.String,
    silent: Schema.optional(Schema.Boolean),
    metadata: Schema.optional(record),
    attachments: Schema.optional(Schema.mutable(Schema.Array(attachment))),
  }),
)
const isQueueMessage = (value: unknown): value is QueueMessageInput => matchesMessage(value)
const isQueueTool = Schema.is(Schema.Struct({ toolName: Schema.String, args: record }))
const parsePayload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export const decodeQueued = (row: QueueRow): Queued | undefined => {
  const payload = Option.getOrUndefined(parsePayload(row.payload))
  const position = { seq: row.seq, queuedAt: row.queued_at }
  if (row.kind === "message" && isQueueMessage(payload)) return { ...position, kind: "message", message: payload }
  if (row.kind === "tool" && isQueueTool(payload))
    return { ...position, kind: "tool", toolName: payload.toolName, args: payload.args }
}
