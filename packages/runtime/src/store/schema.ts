import type { Message, ThreadStatus } from "@standardagents/spec"
import type { NewMessage, Queued, QueueEntry, Thread } from "./ThreadStore.ts"

type Text = string | Uint8Array

// The default decoder drops a leading U+FEFF as a byte-order mark, and that character is part of the text.
const utf8 = new TextDecoder("utf-8", { ignoreBOM: true })
function text(value: Text): string
function text(value: Text | null): string | null
function text(value: Text | null) {
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
  parent_id: message.parent_id ?? null,
  depth: message.depth ?? 0,
  silent: message.silent === true ? 1 : 0,
  metadata: json.metadata,
})

export interface QueueRow {
  readonly seq: number
  readonly kind: QueueEntry["kind"]
  readonly payload: string
  readonly queued_at: number
}

export const queuePayload = (entry: QueueEntry): unknown =>
  entry.kind === "message" ? entry.message : { toolName: entry.toolName, args: entry.args }

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

export const maxJsonDepth = 1000

class Found implements NotJson {
  readonly path: string
  readonly found: string
  constructor(path: string, found: string) {
    this.path = path
    this.found = found
  }
}

const read = <A>(path: string, get: () => A): A => {
  try {
    return get()
  } catch (cause) {
    throw new Found(path, `a property that threw ${String(cause)}`)
  }
}

// Builds the text from the same reads that validate it, so a value that changes between the check and
// the write cannot reach the database. JSON.stringify would drop or rewrite the values rejected here.
export const toJson = (value: unknown): string | NotJson => {
  const ancestors = new Set<object>()
  const write = (value: unknown, path: string): string => {
    switch (typeof value) {
      case "string":
        return JSON.stringify(value)
      case "boolean":
        return String(value)
      case "number":
        if (Number.isFinite(value)) return JSON.stringify(value)
        throw new Found(path, String(value))
      case "bigint":
        throw new Found(path, "a BigInt")
      case "object": {
        if (value === null) return "null"
        if (ancestors.has(value)) throw new Found(path, "a circular reference")
        if (ancestors.size === maxJsonDepth) throw new Found(path, `nesting deeper than ${maxJsonDepth} levels`)
        ancestors.add(value)
        let text: string
        if (Array.isArray(value)) {
          const items: Array<string> = []
          const length = read(path, () => value.length)
          for (let index = 0; index < length; index++)
            items.push(
              write(
                read(path, () => value[index]),
                `${path}[${index}]`,
              ),
            )
          text = `[${items.join(",")}]`
        } else {
          // A plain object has no prototype or one that has none itself, in whichever realm made it.
          // Anything else, such as a Date or a class instance, can serialize to a value that differs from its members.
          const prototype = read(path, () => Object.getPrototypeOf(value))
          if (prototype !== null && read(path, () => Object.getPrototypeOf(prototype)) !== null)
            throw new Found(path, `a ${read(path, () => prototype.constructor?.name) ?? "non-plain"} object`)
          if (typeof read(path, () => (value as { toJSON?: unknown }).toJSON) === "function")
            throw new Found(path, "an object with a toJSON method")
          const members: Array<string> = []
          for (const [key, member] of read(path, () => Object.entries(value)))
            if (member !== undefined) members.push(`${JSON.stringify(key)}:${write(member, `${path}.${key}`)}`)
          text = `{${members.join(",")}}`
        }
        ancestors.delete(value)
        return text
      }
      default:
        throw new Found(path, typeof value === "undefined" ? "undefined" : `a ${typeof value}`)
    }
  }
  try {
    return write(value, "$")
  } catch (error) {
    if (error instanceof Found) return { path: error.path, found: error.found }
    throw error
  }
}
