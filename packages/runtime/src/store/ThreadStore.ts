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

export interface Admitted {
  readonly queued: Queued
  // True when no execution held the thread, so this admission started a run that the caller now executes.
  readonly claimed: boolean
}

export interface Holder {
  readonly id: string
  readonly pid: number
}

// settled: the run ended and released the thread. continue: the queue holds work, so the run goes on.
// superseded: the flow no longer holds the thread, and nothing was written.
export type Settlement = "settled" | "capped" | "continue" | "superseded"

export class HandleExpired extends Data.TaggedError("HandleExpired") {
  override get message() {
    return "This handle has expired. Use a current thread handle."
  }
}

export interface HandleOwner {
  readonly flowId: string | undefined
  readonly terminated: number | null
  readonly expired: () => boolean
}

export const WritingHandle = Context.Reference<HandleOwner | undefined>("spindle/WritingHandle", {
  defaultValue: () => undefined,
})

export type WriteRefused = FlowEnded | ThreadTerminated | HandleExpired

export class CallerHasOpenCalls extends Data.TaggedError("CallerHasOpenCalls")<{ readonly messageId: string }> {
  override get message() {
    return `Message ${this.messageId} has open tool calls. Wait for the run to settle before deleting it.`
  }
}
export interface MessagePosition {
  readonly seq: number
  readonly callerSeq: number | null
}
export const positions = new WeakMap<Message, MessagePosition>()

export const callerSequence = (caller: Message) => {
  const position = positions.get(caller)
  if (!position) throw new Error("Stored caller has no sequence")
  return position.seq
}
export type InsertOptions =
  | { readonly flowId: string; readonly callerSeq?: number; readonly dequeue?: number }
  | { readonly flowId?: never; readonly callerSeq?: never; readonly dequeue?: never }

export class ThreadStore extends Context.Service<
  ThreadStore,
  {
    readonly createThread: (thread: NewThread) => Effect.Effect<Thread, ThreadNotFound | ValueNotJson | SqlError>
    readonly getThread: (threadId: string) => Effect.Effect<Thread, ThreadNotFound | SqlError>
    readonly terminate: (threadId: string) => Effect.Effect<number, ThreadNotFound | WriteRefused | SqlError>

    readonly appendMessages: (
      threadId: string,
      messages: ReadonlyArray<NewMessage>,
    ) => Effect.Effect<ReadonlyArray<Message>, ThreadNotFound | ThreadTerminated | ValueNotJson | SqlError>
    // Stores a message whose id and created_at the caller already chose, as a before_create_message hook saw them.
    readonly insertMessage: (
      threadId: string,
      message: IdentifiedMessage,
      options?: InsertOptions,
    ) => Effect.Effect<
      Inserted,
      ThreadNotFound | ValueNotJson | MessageIdTaken | WriteRefused | QueueEntryGone | SqlError
    >
    // Every insert, update, and delete of one of the thread's messages raises its revision by one, whoever writes.
    readonly revision: (threadId: string) => Effect.Effect<number, ThreadNotFound | SqlError>
    // Every message of the thread, oldest first and silent ones included, and the revision they match.
    readonly history: (threadId: string) => Effect.Effect<ThreadHistory, ThreadNotFound | SqlError>
    readonly latestMessageSeq: (threadId: string) => Effect.Effect<number, SqlError>
    readonly messagesAfter: (
      threadId: string,
      seq: number,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly seq: number; readonly admission: number | null; readonly message: Message }>,
      SqlError
    >
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
    ) => Effect.Effect<Message, MessageNotFound | ValueNotJson | WriteRefused | SqlError>
    readonly deleteMessage: (
      threadId: string,
      messageId: string,
    ) => Effect.Effect<boolean, CallerHasOpenCalls | WriteRefused | SqlError>

    // Runtime sections 2 and 9 in one transaction: refuses a terminated thread, queues the entry, and claims the
    // thread for the caller when no execution holds it.
    readonly admit: (
      threadId: string,
      entry: QueueEntry,
      claim: Claim,
    ) => Effect.Effect<Admitted, ThreadNotFound | WriteRefused | ValueNotJson | SqlError>
    // Claims a thread that holds queued work and that no execution holds, for work that waits behind a run that
    // stopped or failed. Returns whether the caller now runs it.
    readonly claim: (threadId: string, claim: Claim) => Effect.Effect<boolean, SqlError>
    readonly isQueued: (threadId: string, seq: number) => Effect.Effect<boolean, SqlError>
    // The oldest entry, which stays queued until the message that delivers it is inserted.
    readonly nextQueued: (threadId: string, flowId?: string) => Effect.Effect<Queued | undefined, SqlError>
    readonly queueLength: (threadId: string) => Effect.Effect<number, SqlError>
    // Ends the flow's run. Every call of the run that has no result gets an error result with the closing text.
    readonly settle: (
      threadId: string,
      flowId: string,
      outcome: { readonly state: "idle" | "failed"; readonly reason: string },
      options: { readonly continueIfQueued: boolean; readonly atCap?: boolean; readonly closing: string },
    ) => Effect.Effect<Settlement, SqlError>
    // Settles each running thread whose holder process is gone, or only the given thread, as failed with
    // execution_lost, and returns their ids.
    readonly recover: (threadId?: string, force?: boolean) => Effect.Effect<ReadonlyArray<string>, SqlError>
    readonly registerHolder: (holder: Holder) => Effect.Effect<void, SqlError>
    readonly dropHolder: (holderId: string) => Effect.Effect<void, SqlError>
    readonly holderOf: (threadId: string) => Effect.Effect<Holder | null, SqlError>
    readonly owned: (holderId: string) => Effect.Effect<ReadonlyMap<string, string>, SqlError>

    readonly getValue: (threadId: string, key: string) => Effect.Effect<unknown, KeyNotWellFormed | SqlError>
    readonly setValue: (
      threadId: string,
      key: string,
      value: unknown,
    ) => Effect.Effect<void, WriteRefused | KeyNotWellFormed | ValueNotJson | ThreadNotFound | SqlError>

    readonly transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>
  }
>()("spindle/ThreadStore") {}
