import type {
  AgentDefinition,
  AttachmentRef,
  HookDefinitionResult,
  HookName,
  Message,
  ModelDefinition,
  PromptDefinition,
  ProviderUsage,
  ThreadState,
  ThreadStatus,
  ToolDefinition,
} from "@standardagents/spec"

// A project the scenarios define in memory. Tools are keyed by name, as a file name names them on disk.
export interface Project {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly prompts: ReadonlyArray<PromptDefinition>
  readonly models: ReadonlyArray<ModelDefinition>
  // biome-ignore lint/suspicious/noExplicitAny: a tool's state, argument, and uses types differ per tool.
  readonly tools?: Readonly<Record<string, ToolDefinition<any, any, any, any>>>
  // Hooks are found by their id, as a prompt's or an agent's hooks list names them.
  readonly hooks?: ReadonlyArray<HookDefinitionResult<HookName>>
}

export interface LoadOptions {
  // The runtime instance environment, the lowest level of Threads section 2.3.
  readonly instanceEnv?: Readonly<Record<string, string>>
  // How long one hook call may run, in milliseconds. Hooks section 1.2 asks for a limit and names none.
  readonly hookTimeoutMs?: number
}

export interface SendOptions {
  // How many times one step may repeat a model request after a retryable provider error or a response that
  // breaks the prompt's toolChoice.
  readonly retries?: number
  // How many model steps one execution may take before the runtime ends it with max_total_steps.
  readonly stepCap?: number
}

export interface RunError {
  readonly message: string
  readonly code?: string
  readonly statusCode?: number
  readonly retryAfter?: number
  readonly origin?: string
  readonly upstream?: string
}

export interface ModelCall {
  readonly step: number
  readonly attempt: number
  readonly model: string
  readonly finishReason?: string
  readonly usage?: ProviderUsage
  readonly error?: {
    readonly message: string
    readonly code: string
    readonly statusCode?: number
    readonly origin?: string
    readonly upstream?: string
  }
  readonly rejected?: string
  readonly images?: number
  readonly providerTools?: number
  readonly metadata?: Record<string, unknown> | null
  readonly metadataError?: string
}

// Why a run stopped. Durable run status arrives in M1-6, so until then this is the public observation.
export interface RunOutcome {
  readonly status: "idle" | "failed"
  readonly reason: string
  readonly steps: number
  readonly error?: RunError
  readonly stopTool?: {
    readonly tool: string
    readonly callId: string
    readonly status: string
    readonly value: unknown
  }
  readonly modelCalls: ReadonlyArray<ModelCall>
}

// A message that a client or another component writes into history, outside the run.
export interface SeedMessage {
  readonly role: Message["role"]
  readonly content: string | null
  readonly name?: string
  readonly tool_calls?: string
  readonly tool_call_id?: string
  readonly tool_status?: "success" | "error"
  readonly reasoning_content?: string
  readonly reasoning_details?: string
  readonly prompt?: string
  readonly silent?: boolean
  readonly depth?: number
  readonly attachments?: Array<AttachmentRef>
  readonly metadata?: Record<string, unknown>
}

// One message row as a second connection reads it, with the facts the runtime records beside the message.
export interface StoredMessage {
  readonly id: string
  // The position of the row in the store. A later row has a higher number.
  readonly seq: number
  readonly role: string
  readonly content: string | null
  // The execution that the runtime inserted the message for, or null for a message written from outside one.
  readonly flowId: string | null
  // On a tool result, the seq of the message that holds its call. Null on every other message.
  readonly callerSeq: number | null
}

// One queue row as a second connection reads it.
export interface StoredQueueEntry {
  readonly seq: number
  readonly kind: string
  // The payload text as the row holds it.
  readonly payload: string
  // True when the runtime set the entry aside as a failed delivery. Such an entry is never delivered.
  readonly failed: boolean
}

// Everything a thread stores, read on a connection that no run uses.
export interface StoredThread {
  readonly status: ThreadStatus
  readonly terminated: number | null
  // The flow that holds the thread and the process id of its holder, or null when no execution holds the thread.
  readonly claim: { readonly flowId: string; readonly pid: number | null } | null
  // Goes up by one for every insert, update, and delete of one of the thread's messages.
  readonly revision: number
  readonly messages: ReadonlyArray<StoredMessage>
  readonly queue: ReadonlyArray<StoredQueueEntry>
  readonly values: Readonly<Record<string, unknown>>
}

export interface RuntimeSession {
  // Creates a thread and runs its after_thread_created hooks before it resolves.
  readonly createThread: (agent: string) => Promise<string>
  // The ThreadState that an endpoint or another caller outside an execution sees.
  readonly state: (threadId: string) => Promise<ThreadState>
  // The lines the runtime logged, such as a hook that failed.
  readonly logs: () => ReadonlyArray<string>
  // Delivers a message from the human side and resolves when the run that takes it settles. When another session runs
  // the thread, the outcome is the run status once that session lets the thread rest, with no steps.
  readonly send: (threadId: string, content: string, options?: SendOptions) => Promise<RunOutcome>
  // Resolves with the outcome of the run that this session executes for the thread once it settles, or with
  // undefined at once when this session executes none, as after a queueMessage that another session took.
  readonly settled: (threadId: string) => Promise<RunOutcome | undefined>
  // Opens another session on the same database with its own claims, as a second process would.
  readonly peer: () => Promise<RuntimeSession>
  // Reads every message of a thread, oldest first and silent ones included, on a connection the run does not use.
  readonly messages: (threadId: string) => Promise<ReadonlyArray<Message>>
  // Writes messages on a connection the run does not use, as another process would, before or during a run.
  readonly seed: (threadId: string, messages: ReadonlyArray<SeedMessage>) => Promise<void>
  // Interrupts the execution that this session runs for the thread, as the second Ctrl-C of spindle run does, and
  // resolves once the abort is requested. It does not wait for the tools and hooks of that execution to return.
  // Resolves false when this session runs no execution for the thread.
  readonly abort: (threadId: string) => Promise<boolean>
  // Reads what the thread stores on a connection that no run uses.
  readonly inspect: (threadId: string) => Promise<StoredThread>
  // What spindle recover <thread> --force does: settles a running thread failed with execution_lost although its
  // holder is alive. The code of the old execution keeps running in its session, and its writes are stale from then on.
  readonly forceRecover: (threadId: string) => Promise<void>
  // Writes one queue row with this payload text on a connection that no run uses, as a damaged file or a file from
  // another version would hold it.
  readonly queueRaw: (threadId: string, kind: "message" | "tool", payload: string) => Promise<void>
  // From now on every write that would end the thread's run fails, as a full disk fails it.
  readonly breakSettlement: (threadId: string) => Promise<void>
  readonly close: () => Promise<void>
}

export interface RuntimeDriver {
  readonly name: string
  readonly load: (project: Project, options?: LoadOptions) => Promise<RuntimeSession>
}
