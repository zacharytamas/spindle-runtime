import {
  type LLMProviderInterface,
  ProviderError,
  type ProviderErrorCode,
  type ProviderFactory,
  type ProviderFactoryConfig,
  type ProviderFinishReason,
  type ProviderReasoningDetail,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderStreamChunk,
  type ProviderToolCallPart,
  type ProviderUsage,
  type ResponseSummary,
} from "@standardagents/spec"

export interface ScriptedCall {
  readonly id?: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export interface ScriptedResponse {
  readonly text?: string | null
  readonly reasoning?: string
  readonly reasoningDetails?: Array<ProviderReasoningDetail>
  readonly toolCalls?: ReadonlyArray<ScriptedCall>
  readonly finishReason?: ProviderFinishReason
  readonly usage?: ProviderUsage
}

export interface ScriptedChunks {
  // A function in the list runs when the stream reaches it, and the stream waits for its promise.
  readonly chunks: ReadonlyArray<ProviderStreamChunk | (() => Promise<void>)>
  readonly thenThrow?: unknown
}

export type ScriptStep =
  | ScriptedResponse
  | ScriptedChunks
  | { readonly reject: unknown }
  | ((request: RecordedRequest) => ScriptStep | Promise<ScriptStep>)

export type RecordedRequest = Omit<ProviderRequest, "signal">

export interface ScriptedProviderOptions {
  readonly name?: string
  readonly getResponseMetadata?: (
    summary: ResponseSummary,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown> | null>
}

const usage: ProviderUsage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }

export class ScriptedProvider implements LLMProviderInterface {
  readonly name: string
  readonly specificationVersion = "1" as const
  readonly requests: Array<RecordedRequest> = []
  completedStreams = 0
  readonly configs: Array<ProviderFactoryConfig> = []
  readonly getResponseMetadata?: NonNullable<ScriptedProviderOptions["getResponseMetadata"]>
  readonly factory: ProviderFactory
  private readonly steps: Array<ScriptStep>
  private calls = 0

  constructor(steps: ReadonlyArray<ScriptStep>, options: ScriptedProviderOptions = {}) {
    this.steps = [...steps]
    this.name = options.name ?? "scripted"
    if (options.getResponseMetadata !== undefined) this.getResponseMetadata = options.getResponseMetadata
    this.factory = (config) => {
      this.configs.push(config)
      return this
    }
  }

  private async next(request: ProviderRequest): Promise<ScriptedResponse | ScriptedChunks> {
    const { signal: _, ...recorded } = request
    const copy = structuredClone(recorded)
    this.requests.push(copy)
    let step = this.steps.shift()
    if (step === undefined) throw new Error(`The script has no step left for request ${this.requests.length}`)
    while (typeof step === "function") step = await step(copy)
    if ("reject" in step) throw step.reject
    return step
  }

  private chunksOf(step: ScriptedResponse): Array<ProviderStreamChunk> {
    const chunks: Array<ProviderStreamChunk> = []
    if (step.reasoning !== undefined) chunks.push({ type: "reasoning-delta", delta: step.reasoning })
    if (typeof step.text === "string") chunks.push({ type: "content-delta", delta: step.text })
    for (const call of step.toolCalls ?? []) {
      this.calls += 1
      const id = call.id ?? `call_${this.calls}`
      chunks.push({ type: "tool-call-start", id, name: call.name })
      chunks.push({ type: "tool-call-delta", id, argumentsDelta: JSON.stringify(call.arguments) })
      chunks.push({ type: "tool-call-done", id, arguments: call.arguments })
    }
    chunks.push({
      type: "finish",
      finishReason: step.finishReason ?? ((step.toolCalls ?? []).length > 0 ? "tool_calls" : "stop"),
      usage: step.usage ?? usage,
      ...(step.reasoningDetails === undefined ? {} : { reasoningDetails: step.reasoningDetails }),
    })
    return chunks
  }

  async stream(request: ProviderRequest): Promise<AsyncIterable<ProviderStreamChunk>> {
    const step = await this.next(request)
    const chunks = "chunks" in step ? step.chunks : this.chunksOf(step)
    const thenThrow = "chunks" in step ? step.thenThrow : undefined
    const completed = () => {
      this.completedStreams += 1
    }
    return (async function* () {
      for (const chunk of chunks) {
        if (typeof chunk === "function") await chunk()
        else yield chunk
      }
      if (thenThrow !== undefined) throw thenThrow
      completed()
    })()
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const step = await this.next(request)
    const chunks = ("chunks" in step ? step.chunks : this.chunksOf(step)).filter(
      (chunk): chunk is ProviderStreamChunk => typeof chunk !== "function",
    )
    let content: string | null = null
    let reasoning: string | undefined
    const calls = new Map<string, ProviderToolCallPart>()
    let finish: ProviderResponse["finishReason"] | undefined
    let total = usage
    let details: Array<ProviderReasoningDetail> | undefined
    for (const chunk of chunks) {
      if (chunk.type === "content-delta") content = (content ?? "") + chunk.delta
      if (chunk.type === "reasoning-delta") reasoning = (reasoning ?? "") + chunk.delta
      if (chunk.type === "tool-call-start") calls.set(chunk.id, { id: chunk.id, name: chunk.name, arguments: {} })
      if (chunk.type === "tool-call-done") {
        const call = calls.get(chunk.id)
        if (call !== undefined) call.arguments = chunk.arguments
      }
      if (chunk.type === "finish") {
        finish = chunk.finishReason
        total = chunk.usage
        details = chunk.reasoningDetails
      }
      if (chunk.type === "error") throw new ProviderError(chunk.error, (chunk.code ?? "unknown") as ProviderErrorCode)
    }
    if ("chunks" in step && step.thenThrow !== undefined) throw step.thenThrow
    if (finish === undefined) throw new ProviderError("The scripted response has no finish chunk", "server_error")
    return {
      content,
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(details === undefined ? {} : { reasoningDetails: details }),
      ...(calls.size === 0 ? {} : { toolCalls: [...calls.values()] }),
      finishReason: finish,
      usage: total,
    }
  }
}
