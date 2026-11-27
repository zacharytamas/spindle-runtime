import type {
  AgentDefinition,
  AttachmentRef,
  Message,
  ModelDefinition,
  PromptDefinition,
  ProviderUsage,
  ToolDefinition,
} from "@standardagents/spec"

// A project the scenarios define in memory. Tools are keyed by name, as a file name names them on disk.
export interface Project {
  readonly agents: ReadonlyArray<AgentDefinition>
  readonly prompts: ReadonlyArray<PromptDefinition>
  readonly models: ReadonlyArray<ModelDefinition>
  // biome-ignore lint/suspicious/noExplicitAny: a tool's state, argument, and uses types differ per tool.
  readonly tools?: Readonly<Record<string, ToolDefinition<any, any, any, any>>>
}

export interface LoadOptions {
  // The runtime instance environment, the lowest level of Threads section 2.3.
  readonly instanceEnv?: Readonly<Record<string, string>>
}

export interface SendOptions {
  // How many times one step may repeat a model request after a retryable provider error or a response that
  // breaks the prompt's toolChoice.
  readonly retries?: number
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

// A message written into history before a run, as a client or another component would have written it.
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
}

export interface RuntimeSession {
  readonly createThread: (agent: string) => Promise<string>
  // Delivers a message from the human side and resolves when the run it starts settles.
  readonly send: (threadId: string, content: string, options?: SendOptions) => Promise<RunOutcome>
  // Reads every message of a thread, oldest first and silent ones included, on a connection the run does not use.
  readonly messages: (threadId: string) => Promise<ReadonlyArray<Message>>
  readonly seed: (threadId: string, messages: ReadonlyArray<SeedMessage>) => Promise<void>
  readonly close: () => Promise<void>
}

export interface RuntimeDriver {
  readonly name: string
  readonly load: (project: Project, options?: LoadOptions) => Promise<RuntimeSession>
}
