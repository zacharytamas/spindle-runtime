import type {
  LLMProviderInterface,
  Message,
  PromptToolConfig,
  ProviderRequest,
  ThreadState,
  ToolResult,
} from "@standardagents/spec"
import { Cause, Effect, Fiber } from "effect"
import { providerFor, resolveConfig } from "../providers/config.ts"
import type { Registry } from "../registry/Registry.ts"
import { type NewMessage, ThreadStore } from "../store/ThreadStore.ts"
import { buildRequest, promptScope, renderSystemPrompt, toProviderMessages, turnStartOf } from "./assemble.ts"
import { callModel, type ModelCall, type ModelResponse } from "./call.ts"
import { resolveEnv } from "./env.ts"
import { redactDeep, redactor } from "./redact.ts"
import { stopReason } from "./stop-rules.ts"
import { type ExecutionRecord, makeThreadState } from "./thread-state.ts"
import { failed, invokeTool, runToolCall, scopeFor, storedResult, type ToolCall, type ToolContext } from "./tools.ts"
import type { Phase, TraceEntry } from "./trace.ts"
import { type FunctionTool, type Loaded, prepareTurn, roleOf, type Turn } from "./turn.ts"

export type ExecutionEvent =
  | { readonly type: "trace"; readonly entry: TraceEntry }
  | { readonly type: "message"; readonly message: Message }
  | { readonly type: "request"; readonly request: ProviderRequest }

export interface ExecutionOptions {
  readonly retries?: number
  readonly stepCap?: number
  readonly provider?: LLMProviderInterface
  // redact removes the secret values the execution knows from text, such as a line an observer prints.
  readonly observe?: (event: ExecutionEvent, redact?: (text: string) => string) => Effect.Effect<void>
}

export interface RunError {
  readonly message: string
  readonly code?: string
  readonly statusCode?: number
  readonly retryAfter?: number
  readonly origin?: string
  readonly upstream?: string
}

export interface StopToolOutcome {
  readonly tool: string
  readonly callId: string
  readonly status: "success" | "error"
  readonly value: unknown
}

export interface RunOutcome {
  readonly threadId: string
  readonly flowId: string
  readonly status: "idle" | "failed"
  readonly reason: string
  readonly steps: number
  readonly error?: RunError
  readonly stopTool?: StopToolOutcome
  readonly trace: ReadonlyArray<TraceEntry>
  readonly modelCalls: ReadonlyArray<ModelCall>
}

export const DEFAULT_RETRIES = 2
export const DEFAULT_STEP_CAP = 1000

const parseJson = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

const preview = (text: string) => (text.length > 200 ? `${text.slice(0, 200)}...` : text)

// A call is run only when the provider named it and finished its arguments as one JSON object.
const toolCallsOf = (response: ModelResponse): Array<ToolCall> =>
  [...response.calls.values()].map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    argumentsText: call.argumentsText,
    problem:
      call.name === ""
        ? `The provider sent call ${call.id} without the name of a tool`
        : call.arguments === undefined
          ? `The model sent arguments for ${call.name} that are not a valid JSON object, so the tool did not run. It sent: ${preview(call.argumentsText)}`
          : undefined,
  }))

// Messages section 1.3: reasoning details go back only to the model that produced them, so the message records
// which model definition and native model that was. A later model under the same prompt name gets none.
const reasoningSource = (turn: Turn) => ({
  definition: turn.model.definition.qualifiedName,
  model: turn.model.value.model,
})

// The text, reasoning text, and call arguments that the model returned are stored with secrets redacted. The
// opaque reasoning details are stored as returned, because a provider may sign them. Messages section 1 stores
// arguments as the JSON text of an object, so arguments that are not one are kept as the text of invalid_json.
const responseMessage = (
  turn: Turn,
  response: ModelResponse,
  calls: ReadonlyArray<ToolCall>,
  redact: (text: string) => string,
): NewMessage => {
  const extra = Object.fromEntries(
    [...response.calls.values()].flatMap((call) =>
      call.extraContent === undefined ? [] : [[call.id, call.extraContent] as const],
    ),
  )
  return {
    role: roleOf(turn.side),
    content: response.content === null ? null : redact(response.content),
    tool_calls:
      calls.length === 0
        ? null
        : JSON.stringify(
            calls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(
                  call.arguments === undefined
                    ? { invalid_json: redact(call.argumentsText) }
                    : redactDeep(redact, call.arguments),
                ),
              },
            })),
          ),
    reasoning_content: response.reasoning === null ? null : redact(response.reasoning),
    reasoning_details: response.reasoningDetails === undefined ? null : JSON.stringify(response.reasoningDetails),
    prompt: turn.prompt.definition.qualifiedName,
    status: "completed",
    metadata: {
      ...(Object.keys(extra).length === 0 ? {} : { tool_call_extra: extra }),
      ...(response.reasoningDetails === undefined ? {} : { reasoning_source: reasoningSource(turn) }),
    },
  }
}

const stopToolOutcome = (turn: Turn, calls: ReadonlyArray<ToolCall>, results: ReadonlyArray<ToolResult>) => {
  const index = calls.findIndex((call) => call.name === turn.config.stopTool)
  const call = calls[index]
  const result = results[index]
  if (call === undefined || result === undefined) return undefined
  const property = turn.config.stopToolResponseProperty
  const parsed = parseJson(result.result)
  const value =
    property === undefined
      ? (result.result ?? null)
      : typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, property)
        ? (parsed as Record<string, unknown>)[property]
        : null
  return { tool: call.name, callId: call.id, status: result.status, value } satisfies StopToolOutcome
}

// A value that the prompt or one of its tools declares secret is known before the first request, so that its
// redaction does not wait for a tool to read it.
const addDeclaredSecrets = Effect.fn("addDeclaredSecrets")(function* (turn: Turn, secrets: Set<string>) {
  const declared = [
    ...(turn.prompt.value.variables ?? []).map((variable) => ({ variable, scope: promptScope(turn) })),
    ...[...turn.tools.values()].flatMap((exposed) =>
      (exposed.tool.value.variables ?? []).map((variable) => ({ variable, scope: scopeFor(turn, exposed.entry) })),
    ),
  ]
  for (const { variable, scope } of declared)
    if (variable.type === "secret") {
      const value = yield* resolveEnv(scope, variable.name)
      if (value !== undefined) secrets.add(value)
    }
})

const describe = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

export const runExecution = (threadId: string, options: ExecutionOptions = {}) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    const services = yield* Effect.context<Registry | ThreadStore>()
    const retries = options.retries ?? DEFAULT_RETRIES
    const stepCap = options.stepCap ?? DEFAULT_STEP_CAP
    const flowId = crypto.randomUUID()
    const trace: Array<TraceEntry> = []
    const modelCalls: Array<ModelCall> = []
    const pending: Array<Fiber.Fiber<void>> = []
    const secrets = new Set<string>()
    const redact = redactor(secrets)
    const observe = (event: ExecutionEvent) =>
      options.observe === undefined ? Effect.void : options.observe(event, redact)
    // Only the text a tool, a provider, or a model wrote is redacted, never a field that the runtime reads back.
    const redactError = <E extends { readonly message: string; readonly upstream?: string }>(error: E): E => ({
      ...error,
      message: redact(error.message),
      ...(error.upstream === undefined ? {} : { upstream: redact(error.upstream) }),
    })
    const redactResult = (result: ToolResult): ToolResult => ({
      ...result,
      ...(result.result === undefined ? {} : { result: redact(result.result) }),
      ...(result.error === undefined ? {} : { error: redact(result.error) }),
      ...(result.error_code === undefined ? {} : { error_code: redact(result.error_code) }),
      ...(result.error_data === undefined ? {} : { error_data: redactDeep(redact, result.error_data) }),
      ...(result.attachments === undefined
        ? {}
        : {
            attachments: result.attachments.map((attachment) => ({
              ...attachment,
              ...(typeof attachment.name === "string" ? { name: redact(attachment.name) } : {}),
              ...("description" in attachment && typeof attachment.description === "string"
                ? { description: redact(attachment.description) }
                : {}),
            })),
          }),
    })
    const abort = new AbortController()
    let step = 0
    let steps = 0

    const record = (phase: Phase, detail: string) => {
      const entry: TraceEntry = { step, phase, detail: redact(detail) }
      trace.push(entry)
      return observe({ type: "trace", entry })
    }

    const settle = (
      status: RunOutcome["status"],
      reason: string,
      extra: { readonly error?: RunError; readonly stopTool?: StopToolOutcome } = {},
    ) =>
      Effect.gen(function* () {
        yield* Effect.forEach(pending, Fiber.join, { discard: true })
        const calls = modelCalls.map((call) => ({
          ...call,
          ...(call.error === undefined ? {} : { error: redactError(call.error) }),
          ...(call.metadataError === undefined ? {} : { metadataError: redact(call.metadataError) }),
          ...(call.metadata == null ? {} : { metadata: redactDeep(redact, call.metadata) }),
        }))
        const { error, ...rest } = extra
        return {
          threadId,
          flowId,
          status,
          reason,
          steps,
          ...rest,
          ...(error === undefined ? {} : { error: redactError(error) }),
          trace,
          modelCalls: calls,
        } satisfies RunOutcome
      })

    const loop = Effect.gen(function* () {
      const thread = yield* store.getThread(threadId)
      const turn = yield* prepareTurn(thread.agentId)
      const history = [...(yield* store.getMessages(threadId, { order: "asc", includeSilent: true })).messages]
      const execution: ExecutionRecord = {
        flowId,
        side: turn.side,
        stepCount: 0,
        sideAStepCount: 0,
        sideBStepCount: 0,
        history,
        abort,
        promptPath: [turn.prompt.definition.qualifiedName],
      }
      const context: Record<string, unknown> = {}
      const base = {
        thread,
        services,
        execution,
        context,
        secrets,
      }
      const toolContext: ToolContext = {
        turn,
        stateFor: (tool: Loaded<FunctionTool>, entry: PromptToolConfig | undefined): ThreadState =>
          makeThreadState({
            ...base,
            scope: scopeFor(turn, entry),
            from: tool.definition,
            invoke: (name, args) => invokeTool(toolContext, tool, name, args).pipe(Effect.provideContext(services)),
          }),
      }
      const promptState = makeThreadState({
        ...base,
        scope: promptScope(turn),
        from: turn.prompt.definition,
        invoke: (name) =>
          Effect.succeed({ status: "error", error: `invokeTool(${name}) needs a calling tool and its uses list` }),
      })
      // A scripted run still learns the secret values of the model's real provider config.
      if (options.provider !== undefined) yield* resolveConfig(turn.model, secrets)
      const provider =
        options.provider === undefined
          ? yield* providerFor(turn.model, promptState, secrets)
          : Effect.succeed(options.provider)
      yield* addDeclaredSecrets(turn, secrets)
      // A value a tool reads through env() joins secrets later and is redacted, but it may be a text variable.
      const barred = new Set(secrets)
      const source = JSON.stringify(reasoningSource(turn))
      const acceptsDetails = (message: Message) => JSON.stringify(message.metadata?.reasoning_source) === source
      const prompt = turn.prompt.value
      const turnStart = turnStartOf(history, turn.side)
      while (true) {
        step += 1
        yield* record("drain", "no queue before M1-6")
        const system = yield* renderSystemPrompt(turn, barred)
        const messages = toProviderMessages(history, {
          side: turn.side,
          turnStart,
          includeChat: prompt.includeChat === true,
          includePastTools: prompt.includePastTools === true,
          includeReasoning: prompt.reasoning?.include !== false,
          acceptsDetails,
        })
        const request = buildRequest(turn, system, messages, abort.signal)
        yield* record("assemble", `${request.messages.length} messages, ${request.tools?.length ?? 0} tools`)
        yield* observe({ type: "request", request })
        const response = yield* callModel(
          {
            step,
            provider,
            retries,
            toolChoice: prompt.toolChoice,
            calls: modelCalls,
            pending,
            record: (detail) => record("call", detail),
          },
          request,
        )
        steps += 1
        execution.stepCount += 1
        if (turn.side === "a") execution.sideAStepCount += 1
        else execution.sideBStepCount += 1
        const calls = toolCallsOf(response)
        const [assistant] = yield* store.appendMessages(threadId, [responseMessage(turn, response, calls, redact)])
        if (assistant !== undefined) {
          history.push(assistant)
          yield* record("persist-response", `${assistant.id}, ${calls.length} tool calls`)
          yield* observe({ type: "message", message: assistant })
        }
        if (calls.length === 0) {
          yield* record("tools", "none")
          yield* record("persist-results", "none")
        }
        const results: Array<ToolResult> = []
        for (const call of calls) {
          yield* record("tools", `${call.name} ${call.id}`)
          let result = redactResult(yield* runToolCall(toolContext, call))
          // Runtime section 5.2: data that JSON cannot represent fails this one call, not the step.
          const [stored] = yield* store.appendMessages(threadId, [storedResult(turn, call, result)]).pipe(
            Effect.catchTag("ValueNotJson", (error) => {
              result = failed(`Tool ${call.name} returned data that cannot be stored: ${error.message}`)
              return store.appendMessages(threadId, [storedResult(turn, call, result)])
            }),
          )
          results.push(result)
          if (stored !== undefined) {
            history.push(stored)
            yield* record("persist-results", `${call.id} ${stored.tool_status}`)
            yield* observe({ type: "message", message: stored })
          }
        }
        const reason = stopReason(
          {
            text: response.content,
            calls,
            sideSteps: turn.side === "a" ? execution.sideAStepCount : execution.sideBStepCount,
            totalSteps: execution.stepCount,
          },
          turn.config,
          stepCap,
        )
        yield* record("stop", reason ?? "continue")
        if (reason !== undefined) {
          const stopTool = reason === "stop_tool" ? stopToolOutcome(turn, calls, results) : undefined
          return yield* settle("idle", reason, stopTool === undefined ? {} : { stopTool })
        }
      }
    })

    return yield* loop.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        const found = Cause.findError(cause)
        if (found._tag === "Failure") return settle("failed", "fatal_error", { error: { message: describe(cause) } })
        const error = found.success
        switch (error._tag) {
          case "SetupError":
            return settle("failed", "fatal_error", { error: { message: error.message } })
          case "ProviderFailure":
            return settle("failed", "step_error", {
              error: {
                message: error.message,
                code: error.code,
                ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
                ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
                ...(error.origin === undefined ? {} : { origin: error.origin }),
                ...(error.upstream === undefined ? {} : { upstream: error.upstream }),
              },
            })
          default:
            return settle("failed", "step_error", { error: { message: error.message } })
        }
      }),
      Effect.onInterrupt(() => Effect.sync(() => abort.abort())),
    )
  })
