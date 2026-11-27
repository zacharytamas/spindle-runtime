import type { Message, QueueMessageInput, ThreadStatus } from "@standardagents/spec"
import { Data } from "effect"

export interface Thread {
  readonly id: string
  readonly agentId: string
  readonly parentId: string | null
  readonly arguments: Readonly<Record<string, unknown>>
  readonly createdAt: number
  readonly terminated: number | null
  readonly status: ThreadStatus
}

export interface NewThread {
  readonly agentId: string
  readonly parentId?: string | null
  readonly arguments?: Readonly<Record<string, unknown>>
}

export type NewMessage = Pick<Message, "role"> &
  Partial<
    Pick<
      Message,
      | "content"
      | "name"
      | "tool_calls"
      | "tool_call_id"
      | "tool_status"
      | "status"
      | "attachments"
      | "reasoning_content"
      | "reasoning_details"
      | "prompt"
      | "parent_id"
      | "depth"
      | "silent"
      | "metadata"
    >
  >

export type QueueEntry =
  | { readonly kind: "message"; readonly message: QueueMessageInput }
  | { readonly kind: "tool"; readonly toolName: string; readonly args: Readonly<Record<string, unknown>> }

export type Queued = QueueEntry & { readonly seq: number; readonly queuedAt: number }

export class ThreadNotFound extends Data.TaggedError("ThreadNotFound")<{ readonly threadId: string }> {}

export class MessageNotFound extends Data.TaggedError("MessageNotFound")<{
  readonly threadId: string
  readonly messageId: string
}> {}

export type IdentifiedMessage = NewMessage & Pick<Message, "id" | "created_at">

export interface HistoryRow {
  readonly message: Message
  readonly seq: number
  readonly callerSeq: number | null
}

// The revision is null when the read ran inside a caller's transaction, which may still roll back what it read.
export interface ThreadHistory {
  readonly revision: number | null
  readonly rows: ReadonlyArray<HistoryRow>
}

export class MessageIdTaken extends Data.TaggedError("MessageIdTaken")<{ readonly messageId: string }> {
  override get message() {
    return `a message with id ${JSON.stringify(this.messageId)} already exists`
  }
}

export class ValueNotJson extends Data.TaggedError("ValueNotJson")<{
  readonly field: string
  readonly path: string
  readonly found: string
}> {
  override get message() {
    return `${this.field} holds ${this.found} at ${this.path}, which JSON cannot represent`
  }
}

export class InvalidMessagesQuery extends Data.TaggedError("InvalidMessagesQuery")<{
  readonly option: "limit" | "offset" | "maxDepth"
  readonly value: number
}> {
  override get message() {
    return `getMessages option ${this.option} must be a non-negative integer, got ${this.value}`
  }
}

export class KeyNotWellFormed extends Data.TaggedError("KeyNotWellFormed")<{ readonly key: string }> {
  override get message() {
    return `key ${JSON.stringify(this.key)} holds a lone surrogate, so it is not well-formed Unicode and cannot be stored as UTF-8`
  }
}

export class ThreadTerminated extends Data.TaggedError("ThreadTerminated")<{
  readonly threadId: string
  readonly terminated: number
}> {
  override get message() {
    return `thread ${this.threadId} is terminated, so it takes no new message, queued work, or execution`
  }
}

// A write of an execution whose flow no longer holds the thread: another process settled it as lost, or terminate
// settled it.
export class FlowEnded extends Data.TaggedError("FlowEnded")<{
  readonly threadId: string
  readonly flowId: string
  readonly why: "terminated" | "superseded"
}> {
  override get message() {
    return this.why === "terminated"
      ? `thread ${this.threadId} was terminated, so execution ${this.flowId} may not write to it`
      : `execution ${this.flowId} no longer holds thread ${this.threadId}, so it may not write to it`
  }
}

export class QueueEntryGone extends Data.TaggedError("QueueEntryGone")<{ readonly seq: number }> {}

export interface Claim {
  readonly holder: string
  readonly flowId: string
}

export interface Holder {
  readonly id: string
  readonly pid: number
}

export class HandleExpired extends Data.TaggedError("HandleExpired") {
  override get message() {
    return "This handle has expired. Use a current thread handle."
  }
}

export type WriteOrigin =
  | { readonly kind: "external" }
  | { readonly kind: "flow"; readonly flowId: string }
  | {
      readonly kind: "handle"
      readonly flowId: string | null
      readonly terminated: number | null
      readonly expired: () => boolean
    }

export const external = { kind: "external" } satisfies WriteOrigin
export const originFlow = (origin: WriteOrigin) => (origin.kind === "external" ? null : origin.flowId)

export class CallerHasOpenCalls extends Data.TaggedError("CallerHasOpenCalls")<{ readonly messageId: string }> {
  override get message() {
    return `Message ${this.messageId} has open tool calls. Wait for the run to settle before deleting it.`
  }
}
