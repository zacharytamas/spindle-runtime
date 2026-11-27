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
import { Data, Effect, Exit, type Fiber, Predicate, Schedule, Scope, Stream } from "effect"
import { isTimeout, providerErrorCode } from "../providers/errors.ts"
import type { SetupError } from "./turn.ts"

export class ProviderFailure extends Data.TaggedError("ProviderFailure")<{
  readonly message: string
  readonly code: ProviderErrorCode
  readonly statusCode?: number
  readonly retryAfter?: number
  readonly origin?: string
  readonly upstream?: string
}> {
  get retryable() {
    return this.code === "rate_limit" || this.code === "server_error" || this.code === "timeout"
  }
}

class ResponseRejected extends Data.TaggedError("ResponseRejected")<{ readonly message: string }> {}

// Providers SHOULD attribute their errors, and the runtime MAY attribute the request boundary when they do not.
// An error with no code, or with the code unknown, that a timeout caused is the timeout of Providers section 7.1.
const failureOf = (cause: unknown, provider: LLMProviderInterface): ProviderFailure => {
  const fields =
    Predicate.isObject(cause) || cause instanceof Error ? (cause as unknown as Record<string, unknown>) : {}
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
  const statusCode = number(fields.statusCode)
  const retryAfter = number(fields.retryAfter)
  const upstream = typeof fields.upstream === "string" ? fields.upstream : undefined
  const code = providerErrorCode(fields.code)
  return new ProviderFailure({
    message:
      cause instanceof Error ? cause.message : typeof fields.message === "string" ? fields.message : String(cause),
    code: code === "unknown" && isTimeout(cause) ? "timeout" : code,
    origin: typeof fields.origin === "string" ? fields.origin : `provider:${provider.name}`,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(upstream === undefined ? {} : { upstream }),
  })
}

interface StreamedCall {
  readonly id: string
  name: string
  argumentsText: string
  arguments: Record<string, unknown> | undefined
  extraContent: Record<string, unknown> | undefined
}

interface Finish {
  readonly finishReason: ProviderFinishReason
  readonly usage: ProviderUsage
}

export interface ModelResponse {
  content: string | null
  reasoning: string | null
  reasoningDetails: Array<ProviderReasoningDetail> | undefined
  readonly calls: Map<string, StreamedCall>
  readonly images: Set<number>
  providerTools: number
  finish: Finish | undefined
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
const applyChunk = (response: ModelResponse, chunk: ProviderStreamChunk): ProviderFailure | undefined => {
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
      if (Predicate.isObject(chunk.arguments)) call.arguments = chunk.arguments
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
      return new ProviderFailure({ message: chunk.error, code: providerErrorCode(chunk.code) })
    default:
      return
  }
}

// Reads a call's argument text as it streams and returns the value of one top-level argument as soon as that value
// is complete, before the rest of the call arrives. Each character is read once.
export const argumentWatcher = (key: string) => {
  let text = ""
  let depth = 0
  let inString = false
  let escaped = false
  let phase: "key" | "colon" | "value" | "string" | "scalar" | "nested" | "after" = "key"
  let start = 0
  let name: unknown
  const complete = (end: number) => {
    if (name !== key) return undefined
    try {
      return { value: JSON.parse(text.slice(start, end)) as unknown }
    } catch {
      return { value: undefined }
    }
  }
  return (delta: string): { readonly value: unknown } | undefined => {
    const from = text.length
    text += delta
    for (let index = from; index < text.length; index++) {
      const char = text[index] ?? ""
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') {
          inString = false
          if (depth === 1 && phase === "key") {
            try {
              name = JSON.parse(text.slice(start, index + 1))
            } catch {
              name = undefined
            }
            phase = "colon"
          } else if (depth === 1 && phase === "string") {
            phase = "after"
            const found = complete(index + 1)
            if (found !== undefined) return found
          }
        }
        continue
      }
      const space = char.trim() === ""
      if (depth === 1 && phase === "scalar" && (char === "," || char === "}" || space)) {
        const found = complete(index)
        if (found !== undefined) return found
        phase = "after"
      }
      if (char === '"') {
        inString = true
        if (depth === 1 && (phase === "key" || phase === "value")) {
          start = index
          if (phase === "value") phase = "string"
        }
      } else if (char === "{" || char === "[") {
        if (depth === 1 && phase === "value") {
          start = index
          phase = "nested"
        }
        depth += 1
      } else if (char === "}" || char === "]") {
        depth -= 1
        if (depth === 1 && phase === "nested") {
          phase = "after"
          const found = complete(index + 1)
          if (found !== undefined) return found
        }
      } else if (depth === 1 && phase === "colon" && char === ":") phase = "value"
      else if (depth === 1 && char === ",") phase = "key"
      else if (depth === 1 && phase === "value" && !space) {
        start = index
        phase = "scalar"
      }
    }
    return undefined
  }
}

// Hooks section 5.1 and Tools section 7. The loop observes each call as it streams.
export interface StreamedCalls {
  readonly progressArgument: (toolName: string) => string | undefined
  readonly started: (call: StreamedCall, progress: string | undefined) => Effect.Effect<void>
  // The calls of an attempt that failed or that the loop rejected. They started and never run.
  readonly abandoned: (calls: ReadonlyArray<StreamedCall>) => Effect.Effect<void>
}

// A call without a progress argument starts when its name is known. A call with one starts when that argument is
// complete, or when the call is done or the stream finishes without it.
const startCalls = (
  response: ModelResponse,
  chunk: ProviderStreamChunk,
  hooks: StreamedCalls,
  started: Array<StreamedCall>,
  watchers: Map<string, (delta: string) => { readonly value: unknown } | undefined>,
) =>
  Effect.gen(function* () {
    const start = (call: StreamedCall, progress: unknown) => {
      started.push(call)
      return hooks.started(call, typeof progress === "string" ? progress : undefined)
    }
    if (chunk.type === "finish") {
      for (const call of response.calls.values()) if (!started.includes(call)) yield* start(call, undefined)
      return
    }
    if (chunk.type !== "tool-call-start" && chunk.type !== "tool-call-delta" && chunk.type !== "tool-call-done") return
    const call = response.calls.get(chunk.id)
    if (call === undefined || call.name === "" || started.includes(call)) return
    const argument = hooks.progressArgument(call.name)
    if (argument === undefined) return yield* start(call, undefined)
    if (chunk.type === "tool-call-done") return yield* start(call, call.arguments?.[argument])
    let watch = watchers.get(call.id)
    let found: { readonly value: unknown } | undefined
    if (watch === undefined) {
      watch = argumentWatcher(argument)
      watchers.set(call.id, watch)
      found = watch(call.argumentsText)
    } else if (chunk.type === "tool-call-delta") found = watch(chunk.argumentsDelta)
    if (found !== undefined) yield* start(call, found.value)
  })

const streamResponse = (
  provider: LLMProviderInterface,
  request: ProviderRequest,
  hooks: StreamedCalls | undefined,
  started: Array<StreamedCall>,
) =>
  Effect.gen(function* () {
    // A provider can reject or stall in cleanup. Start closing its scope without holding the next attempt.
    const cleanup = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
      Effect.forkDetach(Scope.close(scope, exit), { startImmediately: true }),
    )
    // The attempt's signal fires only when the attempt fails or is interrupted. A provider may keep using the
    // request's signal after a response that completed.
    const attempt = yield* Scope.provide(
      Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller, exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => controller.abort())),
      ),
      cleanup,
    )
    const scoped = attempt.signal
    const signal = request.signal === undefined ? scoped : AbortSignal.any([request.signal, scoped])
    const onError = (cause: unknown) => failureOf(cause, provider)
    const iterable = yield* Effect.tryPromise({ try: () => provider.stream({ ...request, signal }), catch: onError })
    const response: ModelResponse = {
      content: null,
      reasoning: null,
      reasoningDetails: undefined,
      calls: new Map(),
      images: new Set(),
      providerTools: 0,
      finish: undefined,
    }
    const watchers = new Map<string, (delta: string) => { readonly value: unknown } | undefined>()
    const pull = Stream.toPull(Stream.fromAsyncIterable(iterable, onError))
    yield* Stream.runForEach(Stream.fromPull(Scope.provide(pull, cleanup)), (chunk) => {
      const failure = applyChunk(response, chunk)
      if (failure !== undefined) return Effect.fail(failure)
      return hooks === undefined ? Effect.void : startCalls(response, chunk, hooks, started, watchers)
    })
    const { finish } = response
    // A stream cut off before its finish chunk is an incomplete response, retried like a server error.
    if (finish === undefined)
      return yield* new ProviderFailure({
        message: "The provider stream ended without a finish chunk",
        code: "server_error",
        origin: `provider:${provider.name}`,
      })
    if (finish.finishReason === "error")
      return yield* new ProviderFailure({
        message: "The provider finished the response with an error",
        code: "unknown",
        origin: `provider:${provider.name}`,
      })
    return { ...response, finish }
  }).pipe(Effect.scoped)

export interface ModelCall {
  readonly step: number
  readonly attempt: number
  readonly model: string
  finishReason?: ProviderFinishReason
  usage?: ProviderUsage
  // Providers section 7: origin and upstream are for logs, so each attempt keeps them, a recovered one included.
  error?: Pick<ProviderFailure, "message" | "code" | "statusCode" | "origin" | "upstream">
  rejected?: string
  images?: number
  providerTools?: number
  metadata?: Record<string, unknown> | null
  metadataError?: string
}

export interface CallContext {
  readonly stopped: () => boolean
  readonly waitForStop: Effect.Effect<void>
  readonly step: number
  // Yields the provider for one backend request. Infrastructure Providers, Per-request Transport: an extension
  // with createFetch is built again for every request, and a retry is a request.
  readonly provider: Effect.Effect<LLMProviderInterface, SetupError>
  readonly retries: number
  readonly toolChoice: "auto" | "none" | "required" | undefined
  readonly calls: Array<ModelCall>
  readonly pending: Array<Fiber.Fiber<void>>
  readonly record: (detail: string) => Effect.Effect<void>
  readonly streamed?: StreamedCalls
}

const violation = (response: ModelResponse, toolChoice: CallContext["toolChoice"]) => {
  if (toolChoice === "required" && response.calls.size === 0)
    return "The prompt requires a tool call and the model returned none"
  if (toolChoice === "none" && response.calls.size > 0)
    return "The prompt sets toolChoice to none and the model called a tool"
  if (response.calls.size === 0 && response.images.size === 0 && (response.content ?? "").trim() === "")
    return "The model returned nothing, with no text and no tool call,"
  return undefined
}

// getResponseMetadata runs beside the loop. The execution joins the fiber before it settles.
const fetchMetadata = (provider: LLMProviderInterface, summary: ResponseSummary, log: ModelCall) => {
  const getResponseMetadata = provider.getResponseMetadata?.bind(provider)
  if (getResponseMetadata === undefined) return Effect.void
  return Effect.tryPromise({
    try: (signal) => getResponseMetadata(summary, signal),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.timeoutOption("30 seconds"),
    Effect.match({
      onFailure: (message) => {
        log.metadataError = message
      },
      onSuccess: (option) => {
        if (option._tag === "Some") log.metadata = option.value
        else log.metadataError = "getResponseMetadata did not settle within 30 seconds"
      },
    }),
  )
}

export const callModel = Effect.fn("callModel")(function* (context: CallContext, request: ProviderRequest) {
  const requestOnce = Effect.gen(function* () {
    const attempt = (yield* Schedule.CurrentMetadata).attempt + 1
    if (context.stopped()) return undefined
    const provider = yield* context.provider
    yield* context.record(`${provider.name} ${request.model} attempt ${attempt}`)
    if (context.stopped()) return undefined
    const log: ModelCall = { step: context.step, attempt, model: request.model }
    context.calls.push(log)
    const started: Array<StreamedCall> = []
    const abandon = () =>
      started.length === 0 || context.streamed === undefined ? Effect.void : context.streamed.abandoned(started)
    const response = yield* streamResponse(provider, request, context.streamed, started).pipe(
      Effect.tapError((failure) =>
        Effect.gen(function* () {
          yield* abandon()
          const { message, code, statusCode, origin, upstream } = failure
          log.error = {
            message,
            code,
            ...(statusCode === undefined ? {} : { statusCode }),
            ...(origin === undefined ? {} : { origin }),
            ...(upstream === undefined ? {} : { upstream }),
          }
        }),
      ),
    )
    const { finish } = response
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
    context.pending.push(yield* Effect.forkChild(fetchMetadata(provider, summary, log)))
    const rejected = violation(response, context.toolChoice)
    if (rejected === undefined) return response
    log.rejected = rejected
    yield* abandon()
    return yield* new ResponseRejected({ message: `${rejected} after ${attempt} requests` })
  })
  const policy = Schedule.exponential(500).pipe(
    Schedule.upTo({ times: context.retries }),
    Schedule.while(
      ({ input }) =>
        !context.stopped() &&
        (input instanceof ResponseRejected || (input instanceof ProviderFailure && input.retryable)),
    ),
    Schedule.modifyDelay(({ input, duration }) => {
      if (!(input instanceof ProviderFailure)) return Effect.succeed(0)
      const delay = input.retryAfter === undefined ? duration : Math.min(input.retryAfter, 60) * 1000
      // A graceful stop wakes the backoff, but lets a request already streaming reach its boundary.
      return Effect.as(Effect.timeoutOption(context.waitForStop, delay), 0)
    }),
  )
  return yield* requestOnce.pipe(
    Effect.retry(policy),
    Effect.catchIf(
      (error) => error._tag !== "SetupError" && context.stopped(),
      () => Effect.undefined,
    ),
  )
})
