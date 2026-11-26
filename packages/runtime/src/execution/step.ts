import type {
  LLMProviderInterface,
  Message,
  PromptDefinition,
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
import { invokeTool, runToolCall, scopeFor, storedResult, type ToolCall, type ToolContext } from "./tools.ts"
import type { Phase, TraceEntry } from "./trace.ts"
import { type FunctionTool, type Loaded, lookup, prepareTurn, roleOf, type Turn } from "./turn.ts"

export type ExecutionEvent =
  | { readonly type: "trace"; readonly entry: TraceEntry }
  | { readonly type: "message"; readonly message: Message }
  | { readonly type: "request"; readonly request: ProviderRequest }

export interface ExecutionOptions {
  readonly retries?: number
  readonly stepCap?: number
  readonly provider?: LLMProviderInterface
  readonly observe?: (event: ExecutionEvent) => Effect.Effect<void>
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
    argumentsText: call.arguments === undefined ? call.argumentsText : JSON.stringify(call.arguments),
    problem:
      call.name === ""
        ? `The provider sent call ${call.id} without the name of a tool`
        : call.arguments === undefined
          ? `The model's arguments for ${call.name} are not a complete JSON object, so the tool did not run. The provider sent: ${preview(call.argumentsText)}`
          : undefined,
  }))

const responseMessage = (turn: Turn, response: ModelResponse, calls: ReadonlyArray<ToolCall>): NewMessage => {
  const extra = Object.fromEntries(
    [...response.calls.values()].flatMap((call) =>
      call.extraContent === undefined ? [] : [[call.id, call.extraContent] as const],
    ),
  )
  return {
    role: roleOf(turn.side),
    content: response.content,
    tool_calls:
      calls.length === 0
        ? null
        : JSON.stringify(
            calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.argumentsText },
            })),
          ),
    reasoning_content: response.reasoning,
    reasoning_details: response.reasoningDetails === undefined ? null : JSON.stringify(response.reasoningDetails),
    prompt: turn.prompt.definition.qualifiedName,
    status: "completed",
    metadata: Object.keys(extra).length === 0 ? {} : { tool_call_extra: extra },
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
      options.observe === undefined ? Effect.void : options.observe(redactDeep(redact, event))
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
        const outcome = { threadId, flowId, status, reason, steps, ...extra, trace, modelCalls } satisfies RunOutcome
        return redactDeep(redact, outcome)
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
      const detailsAccepted = new Map<string, boolean>()
      const acceptsDetails = (message: Message) => {
        const name = message.prompt ?? ""
        return detailsAccepted.get(name) ?? false
      }
      const prompt = turn.prompt.value
      const turnStart = turnStartOf(history, turn.side)
      while (true) {
        step += 1
        yield* record("drain", "no queue before M1-6")
        const system = yield* renderSystemPrompt(turn, barred)
        for (const message of history)
          if (message.prompt != null && !detailsAccepted.has(message.prompt)) {
            const author = yield* lookup<PromptDefinition>("prompt", message.prompt, undefined)
            const model =
              author === undefined ? undefined : yield* lookup("model", author.value.model, author.definition)
            detailsAccepted.set(message.prompt, model?.definition === turn.model.definition)
          }
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
            provider: yield* provider,
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
        const [assistant] = yield* store.appendMessages(threadId, [responseMessage(turn, response, calls)])
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
          const result = redactDeep(redact, yield* runToolCall(toolContext, call))
          results.push(result)
          const [stored] = yield* store.appendMessages(threadId, [storedResult(turn, call, result)])
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
