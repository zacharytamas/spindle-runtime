import type {
  GetMessagesOptions,
  Message,
  MessagesResult,
  MessageUpdates,
  QueueMessageInput,
  ThreadStatus,
} from "@standardagents/spec"
import { Context, Data, type Effect } from "effect"
import type { SqlError } from "effect/sql/SqlError"

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

export type RunStatus = { readonly state: "running" } | { readonly state: "idle" | "failed"; readonly reason: string }

export class ThreadNotFound extends Data.TaggedError("ThreadNotFound")<{ readonly threadId: string }> {}

export class MessageNotFound extends Data.TaggedError("MessageNotFound")<{
  readonly threadId: string
  readonly messageId: string
}> {}

export type IdentifiedMessage = NewMessage & Pick<Message, "id" | "created_at">

// The revision is null when the insert ran inside a caller's transaction, which may still roll it back.
export interface Inserted {
  readonly message: Message
  readonly revision: number | null
}

// The revision is null when the read ran inside a caller's transaction, which may still roll back what it read.
export interface ThreadHistory {
  readonly revision: number | null
  readonly messages: ReadonlyArray<Message>
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

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    readonly createThread: (thread: NewThread) => Effect.Effect<Thread, ThreadNotFound | ValueNotJson | SqlError>
    readonly getThread: (threadId: string) => Effect.Effect<Thread, ThreadNotFound | SqlError>
    readonly terminate: (threadId: string) => Effect.Effect<number, ThreadNotFound | SqlError>
    readonly setStatus: (threadId: string, status: RunStatus) => Effect.Effect<ThreadStatus, ThreadNotFound | SqlError>

    readonly appendMessages: (
      threadId: string,
      messages: ReadonlyArray<NewMessage>,
    ) => Effect.Effect<ReadonlyArray<Message>, ThreadNotFound | ValueNotJson | SqlError>
    // Stores a message whose id and created_at the caller already chose, as a before_create_message hook saw them.
    readonly insertMessage: (
      threadId: string,
      message: IdentifiedMessage,
    ) => Effect.Effect<Inserted, ThreadNotFound | ValueNotJson | MessageIdTaken | SqlError>
    // Every insert, update, and delete of one of the thread's messages raises its revision by one, whoever writes.
    readonly revision: (threadId: string) => Effect.Effect<number, ThreadNotFound | SqlError>
    // Every message of the thread, oldest first and silent ones included, and the revision they match.
    readonly history: (threadId: string) => Effect.Effect<ThreadHistory, ThreadNotFound | SqlError>
    readonly getMessages: (
      threadId: string,
      options?: GetMessagesOptions,
    ) => Effect.Effect<MessagesResult, InvalidMessagesQuery | SqlError>
    readonly getMessage: (threadId: string, messageId: string) => Effect.Effect<Message | null, SqlError>
    // Message ids are unique across threads, so this asks whether any thread holds the id.
    readonly messageIdTaken: (messageId: string) => Effect.Effect<boolean, SqlError>
    readonly updateMessage: (
      threadId: string,
      messageId: string,
      updates: MessageUpdates,
    ) => Effect.Effect<Message, MessageNotFound | ValueNotJson | SqlError>
    readonly deleteMessage: (threadId: string, messageId: string) => Effect.Effect<boolean, SqlError>

    readonly enqueue: (
      threadId: string,
      entry: QueueEntry,
    ) => Effect.Effect<Queued, ThreadNotFound | ValueNotJson | SqlError>
    readonly takeQueue: (threadId: string) => Effect.Effect<ReadonlyArray<Queued>, SqlError>

    readonly getValue: (threadId: string, key: string) => Effect.Effect<unknown, KeyNotWellFormed | SqlError>
    readonly setValue: (
      threadId: string,
      key: string,
      value: unknown,
    ) => Effect.Effect<void, KeyNotWellFormed | ValueNotJson | ThreadNotFound | SqlError>

    readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>
  }
>()("spindle/ThreadStore") {}
