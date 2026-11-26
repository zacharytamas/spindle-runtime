import type {
  LLMProviderInterface,
  ProviderErrorCode,
  ProviderFinishReason,
  ProviderReasoningDetail,
  ProviderRequest,
  ProviderStreamChunk,
  ProviderUsage,
  ResponseSummary,
} from "@standardagents/spec"
import { Data, Effect, type Fiber, Result } from "effect"

const CODES: ReadonlyArray<ProviderErrorCode> = [
  "rate_limit",
  "invalid_request",
  "auth_error",
  "server_error",
  "timeout",
  "unknown",
]
const RETRYABLE: ReadonlyArray<ProviderErrorCode> = ["rate_limit", "server_error", "timeout"]

const isCode = (value: unknown): value is ProviderErrorCode => CODES.includes(value as ProviderErrorCode)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export class ProviderFailure extends Data.TaggedError("ProviderFailure")<{
  readonly message: string
  readonly code: ProviderErrorCode
  readonly statusCode?: number
  readonly retryAfter?: number
  readonly origin?: string
  readonly upstream?: string
}> {
  get retryable() {
    return RETRYABLE.includes(this.code)
  }
}

export class ToolChoiceViolated extends Data.TaggedError("ToolChoiceViolated")<{ readonly message: string }> {}

// Providers SHOULD attribute their errors, and the runtime MAY attribute the request boundary when they do not.
const failureOf = (cause: unknown, provider: LLMProviderInterface): ProviderFailure => {
  const fields = isRecord(cause) || cause instanceof Error ? (cause as unknown as Record<string, unknown>) : {}
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
  const statusCode = number(fields.statusCode)
  const retryAfter = number(fields.retryAfter)
  const upstream = typeof fields.upstream === "string" ? fields.upstream : undefined
  return new ProviderFailure({
    message:
      cause instanceof Error ? cause.message : typeof fields.message === "string" ? fields.message : String(cause),
    code: isCode(fields.code) ? fields.code : "unknown",
    origin: typeof fields.origin === "string" ? fields.origin : `provider:${provider.name}`,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(upstream === undefined ? {} : { upstream }),
  })
}

export interface StreamedCall {
  readonly id: string
  name: string
  argumentsText: string
  arguments: Record<string, unknown> | undefined
  extraContent: Record<string, unknown> | undefined
}

export interface ModelResponse {
  content: string | null
  reasoning: string | null
  reasoningDetails: Array<ProviderReasoningDetail> | undefined
  readonly calls: Map<string, StreamedCall>
  readonly images: Set<number>
  providerTools: number
  finish: { readonly finishReason: ProviderFinishReason; readonly usage: ProviderUsage } | undefined
}

const callOf = (response: ModelResponse, id: string): StreamedCall => {
  let call = response.calls.get(id)
  if (call === undefined) {
    call = { id, name: "", argumentsText: "", arguments: undefined, extraContent: undefined }
    response.calls.set(id, call)
  }
  return call
}

// One chunk at a time, so that a hook can observe a call as it starts and as its arguments arrive.
export const applyChunk = (response: ModelResponse, chunk: ProviderStreamChunk): ProviderFailure | undefined => {
  switch (chunk.type) {
    case "content-delta":
      response.content = (response.content ?? "") + chunk.delta
      return
    case "reasoning-delta":
      response.reasoning = (response.reasoning ?? "") + chunk.delta
      return
    case "tool-call-start": {
      const call = callOf(response, chunk.id)
      if (call.name === "") call.name = chunk.name
      if (chunk.extraContent !== undefined) call.extraContent = chunk.extraContent
      return
    }
    case "tool-call-delta":
      callOf(response, chunk.id).argumentsText += chunk.argumentsDelta
      return
    case "tool-call-done": {
      const call = callOf(response, chunk.id)
      if (isRecord(chunk.arguments)) call.arguments = chunk.arguments
      if (chunk.extraContent !== undefined) call.extraContent = chunk.extraContent
      return
    }
    case "image-done":
      response.images.add(chunk.index)
      return
    case "provider-tool-done":
    case "web-search-done":
      response.providerTools += 1
      return
    case "finish":
      response.finish = { finishReason: chunk.finishReason, usage: chunk.usage }
      if (chunk.reasoningDetails !== undefined) response.reasoningDetails = chunk.reasoningDetails
      return
    case "error":
      return new ProviderFailure({ message: chunk.error, code: isCode(chunk.code) ? chunk.code : "unknown" })
    default:
      return
  }
}

const streamResponse = (provider: LLMProviderInterface, request: ProviderRequest) =>
  Effect.gen(function* () {
    const iterable = yield* Effect.tryPromise({
      try: () => provider.stream(request),
      catch: (cause) => failureOf(cause, provider),
    })
    const iterator = iterable[Symbol.asyncIterator]()
    const response: ModelResponse = {
      content: null,
      reasoning: null,
      reasoningDetails: undefined,
      calls: new Map(),
      images: new Set(),
      providerTools: 0,
      finish: undefined,
    }
    const read = Effect.gen(function* () {
      while (true) {
        const next = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (cause) => failureOf(cause, provider),
        })
        if (next.done === true) break
        const failure = applyChunk(response, next.value)
        if (failure !== undefined) return yield* failure
      }
      if (response.finish === undefined)
        return yield* new ProviderFailure({
          message: "The provider stream ended without a finish chunk",
          code: "unknown",
          origin: `provider:${provider.name}`,
        })
      if (response.finish.finishReason === "error")
        return yield* new ProviderFailure({
          message: "The provider finished the response with an error",
          code: "unknown",
          origin: `provider:${provider.name}`,
        })
      return response
    })
    return yield* read.pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          Promise.resolve(iterator.return?.()).catch(() => {})
        }),
      ),
    )
  })

export interface ModelCall {
  readonly step: number
  readonly attempt: number
  readonly model: string
  finishReason?: ProviderFinishReason
  usage?: ProviderUsage
  error?: { readonly message: string; readonly code: ProviderErrorCode }
  rejected?: string
  images?: number
  providerTools?: number
  metadata?: Record<string, unknown> | null
  metadataError?: string
}

export interface CallContext {
  readonly step: number
  readonly provider: LLMProviderInterface
  readonly retries: number
  readonly toolChoice: "auto" | "none" | "required" | undefined
  readonly calls: Array<ModelCall>
  readonly pending: Array<Fiber.Fiber<void>>
  readonly record: (detail: string) => Effect.Effect<void>
}

const backoff = (failure: ProviderFailure, attempt: number) =>
  failure.retryAfter === undefined ? 500 * 2 ** (attempt - 1) : Math.min(failure.retryAfter, 60) * 1000

const violation = (response: ModelResponse, toolChoice: CallContext["toolChoice"]) => {
  if (toolChoice === "required" && response.calls.size === 0)
    return "The prompt requires a tool call and the model returned none"
  if (toolChoice === "none" && response.calls.size > 0)
    return "The prompt sets toolChoice to none and the model called a tool"
  return undefined
}

// getResponseMetadata runs beside the loop. The execution joins the fiber before it settles.
const fetchMetadata = (provider: LLMProviderInterface, summary: ResponseSummary, log: ModelCall) => {
  const getResponseMetadata = provider.getResponseMetadata?.bind(provider)
  if (getResponseMetadata === undefined) return Effect.void
  return Effect.tryPromise({
    try: (signal) => getResponseMetadata(summary, signal),
    catch: (cause) => cause,
  }).pipe(
    Effect.timeoutOption("30 seconds"),
    Effect.match({
      onFailure: (cause) => {
        log.metadataError = cause instanceof Error ? cause.message : String(cause)
      },
      onSuccess: (option) => {
        if (option._tag === "Some") log.metadata = option.value
        else log.metadataError = "getResponseMetadata did not settle within 30 seconds"
      },
    }),
  )
}

export const callModel = Effect.fn("callModel")(function* (context: CallContext, request: ProviderRequest) {
  for (let attempt = 1; ; attempt++) {
    yield* context.record(`${request.model} attempt ${attempt}`)
    const log: ModelCall = { step: context.step, attempt, model: request.model }
    context.calls.push(log)
    const result = yield* Effect.result(streamResponse(context.provider, request))
    if (Result.isFailure(result)) {
      const failure = result.failure
      log.error = { message: failure.message, code: failure.code }
      if (!failure.retryable || attempt > context.retries) return yield* failure
      yield* Effect.sleep(backoff(failure, attempt))
      continue
    }
    const response = result.success
    const finish = response.finish ?? {
      finishReason: "stop" as const,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    }
    log.finishReason = finish.finishReason
    log.usage = finish.usage
    if (response.images.size > 0) log.images = response.images.size
    if (response.providerTools > 0) log.providerTools = response.providerTools
    const summary: ResponseSummary = {
      model: request.model,
      finishReason: finish.finishReason,
      usage: {
        promptTokens: finish.usage.promptTokens,
        completionTokens: finish.usage.completionTokens,
        totalTokens: finish.usage.totalTokens,
      },
    }
    context.pending.push(yield* Effect.forkChild(fetchMetadata(context.provider, summary, log)))
    const rejected = violation(response, context.toolChoice)
    if (rejected === undefined) return response
    log.rejected = rejected
    if (attempt > context.retries)
      return yield* new ToolChoiceViolated({ message: `${rejected} after ${attempt} requests` })
  }
})
