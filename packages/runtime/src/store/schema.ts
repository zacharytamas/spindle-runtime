import type { Message, ThreadStatus } from "@standardagents/spec"
import type { NewMessage, Queued, QueueEntry, Thread } from "./ThreadStore.ts"

type Text = string | Uint8Array

const utf8 = new TextDecoder()
function text(value: Text): string
function text(value: Text | null): string | null
function text(value: Text | null) {
  return value instanceof Uint8Array ? utf8.decode(value) : value
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
})

export const messageRow = (
  threadId: string,
  id: string,
  createdAt: number,
  message: NewMessage,
): MessageRow & { readonly thread_id: string } => ({
  thread_id: threadId,
  id,
  role: message.role,
  content: message.content ?? null,
  name: message.name ?? null,
  tool_calls: message.tool_calls ?? null,
  tool_call_id: message.tool_call_id ?? null,
  tool_status: message.tool_status ?? null,
  status: message.status ?? null,
  attachments: message.attachments == null ? null : JSON.stringify(message.attachments),
  reasoning_content: message.reasoning_content ?? null,
  reasoning_details: message.reasoning_details ?? null,
  prompt: message.prompt ?? null,
  created_at: createdAt,
  parent_id: message.parent_id ?? null,
  depth: message.depth ?? 0,
  silent: message.silent === true ? 1 : 0,
  metadata: JSON.stringify(message.metadata ?? {}),
})

export interface QueueRow {
  readonly seq: number
  readonly kind: QueueEntry["kind"]
  readonly payload: string
  readonly queued_at: number
}

export const queuePayload = (entry: QueueEntry): string =>
  JSON.stringify(entry.kind === "message" ? entry.message : { toolName: entry.toolName, args: entry.args })

export const toQueued = (row: QueueRow): Queued => {
  const payload = JSON.parse(row.payload)
  const entry: QueueEntry =
    row.kind === "message"
      ? { kind: "message", message: payload }
      : { kind: "tool", toolName: payload.toolName, args: payload.args }
  return { ...entry, seq: row.seq, queuedAt: row.queued_at }
}

export interface NotJson {
  readonly path: string
  readonly found: string
}

// JSON.stringify drops or rewrites these values instead of failing, so a stored value would not read back equal.
export const findNotJson = (value: unknown, path = "$", ancestors: Array<object> = []): NotJson | undefined => {
  switch (typeof value) {
    case "string":
    case "boolean":
      return undefined
    case "number":
      return Number.isFinite(value) ? undefined : { path, found: String(value) }
    case "bigint":
      return { path, found: "a BigInt" }
    case "object": {
      if (value === null) return undefined
      if (ancestors.includes(value)) return { path, found: "a circular reference" }
      const inner = [...ancestors, value]
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
          const found = findNotJson(value[index], `${path}[${index}]`, inner)
          if (found !== undefined) return found
        }
        return undefined
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null)
        return { path, found: `a ${value.constructor?.name ?? "class"} instance` }
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue
        const found = findNotJson(entry, `${path}.${key}`, inner)
        if (found !== undefined) return found
      }
      return undefined
    }
    default:
      return { path, found: typeof value === "undefined" ? "undefined" : `a ${typeof value}` }
  }
}
