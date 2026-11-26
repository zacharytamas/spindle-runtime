import type {
  HookToolCall,
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
import {
  buildRequest,
  checkSystemPrompt,
  fromLLMMessage,
  pastOf,
  promptScope,
  renderSystemPrompt,
  toLLMMessage,
  toProviderMessages,
  withoutReasoning,
} from "./assemble.ts"
import { callModel, type ModelCall, type ModelResponse, type StreamedCalls } from "./call.ts"
import { addSecret, instanceEnv, lookupEnv, newSecrets, type Secrets } from "./env.ts"
import { countHooks, type HookScope, has, runHooks, turnHooks } from "./hooks.ts"
import { createMessage } from "./messages.ts"
import { mapStrings, redactor } from "./redact.ts"
import { stopReason } from "./stop-rules.ts"
import { type ExecutionRecord, makeThreadState } from "./thread-state.ts"
import {
  describe,
  invokeTool,
  ResultUnreadable,
  redactResult,
  runToolCall,
  scopeFor,
  storedResult,
  type ToolCall,
  type ToolContext,
  unstorableResult,
} from "./tools.ts"
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
  // The execution adds each secret value it resolves, so that a caller can redact what it prints.
  readonly secrets?: Set<string>
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

// Messages section 1 stores arguments as the JSON text of an object, so arguments that are not one are kept as the
// text of invalid_json.
const argumentsOf = (call: ToolCall) => JSON.stringify(call.arguments ?? { invalid_json: call.argumentsText })

const hookCall = (call: { readonly id: string; readonly name: string }, args: string): HookToolCall => ({
  id: call.id,
  type: "function",
  function: { name: call.name, arguments: args },
})

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

// The response is stored as the model returned it, so the stored arguments are what the model sent and what the
// next request shows. The tool gets them after its schema validates them, which may transform a value.
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
              function: { name: call.name, arguments: argumentsOf(call) },
            })),
          ),
    reasoning_content: response.reasoning,
    reasoning_details: response.reasoningDetails === undefined ? null : JSON.stringify(response.reasoningDetails),
    prompt: turn.prompt.definition.qualifiedName,
    status: "completed",
    metadata: {
      ...(Object.keys(extra).length === 0 ? {} : { tool_call_extra: extra }),
      ...(response.reasoningDetails === undefined ? {} : { reasoning_source: reasoningSource(turn) }),
    },
  }
}

// The runtime reads the stop property from the result before redaction, and reports the value redacted.
const stopToolOutcome = (
  turn: Turn,
  calls: ReadonlyArray<ToolCall>,
  results: ReadonlyArray<ToolResult>,
  redact: (text: string) => string,
) => {
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
  return {
    tool: call.name,
    callId: call.id,
    status: result.status,
    value: mapStrings(value, redact, redact),
  } satisfies StopToolOutcome
}

// Before the first request, and before spindle run prints a line, the execution learns every secret value that the
// turn can resolve: the provider config's, each value of a name marked secret, and the instance value of each
// variable that the prompt or one of its tools declares.
export const learnSecrets = Effect.fn("learnSecrets")(function* (turn: Turn, secrets: Secrets) {
  yield* resolveConfig(turn.model, secrets)
  const declared = [
    ...(turn.prompt.value.variables ?? []).map((variable) => ({ variable, scope: promptScope(turn) })),
    ...[...turn.tools.values()].flatMap((exposed) =>
      (exposed.tool.value.variables ?? []).map((variable) => ({ variable, scope: scopeFor(turn, exposed.entry) })),
    ),
  ]
  for (const { variable } of declared) if (variable.type === "secret") secrets.names.add(variable.name)
  const lookups = [
    ...declared.map(({ variable, scope }) => ({ name: variable.name, scope })),
    ...[...secrets.names].map((name) => ({ name, scope: promptScope(turn) })),
  ]
  for (const { name, scope } of lookups) {
    const found = yield* lookupEnv(scope, name)
    if (found !== undefined && (found.fromInstance || secrets.names.has(name))) addSecret(secrets, found.value)
    // A definition default hides the instance value from the lookup, and that value is still the operator's secret.
    // An instance value equal to the default is text the definition already shows.
    const instance = yield* instanceEnv(name)
    if (instance !== undefined && instance !== found?.value) addSecret(secrets, instance)
  }
})

const describeCause = (cause: Cause.Cause<unknown>): string => {
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
    const secrets = newSecrets(options.secrets)
    const redact = redactor(secrets.values)
    const observe = (event: ExecutionEvent) => (options.observe === undefined ? Effect.void : options.observe(event))
    // Only the text a tool, a provider, or a model wrote is redacted, never a field that the runtime reads back.
    const redactError = <E extends { readonly message: string; readonly upstream?: string }>(error: E): E => ({
      ...error,
      message: redact(error.message),
      ...(error.upstream === undefined ? {} : { upstream: redact(error.upstream) }),
    })
    // A log keeps no secret in its keys either, and data that cannot be walked is left out.
    const redactLog = (data: Record<string, unknown>) => {
      try {
        return mapStrings(data, redact, redact)
      } catch {
        return null
      }
    }
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
          ...(call.metadata == null ? {} : { metadata: redactLog(call.metadata) }),
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
      const hookSet = yield* turnHooks(turn)
      const readHistory = Effect.map(
        store.getMessages(threadId, { order: "asc", includeSilent: true }),
        (result) => result.messages,
      )
      const atStart = yield* readHistory
      const execution: ExecutionRecord = {
        flowId,
        side: turn.side,
        stepCount: 0,
        sideAStepCount: 0,
        sideBStepCount: 0,
        abort,
        promptPath: [turn.prompt.definition.qualifiedName],
      }
      const context: Record<string, unknown> = {}
      const noInvoke = (name: string) =>
        Effect.succeed<ToolResult>({
          status: "error",
          error: `invokeTool(${name}) needs a calling tool and its uses list`,
        })
      const hooks: HookScope = {
        set: hookSet,
        stateFor: (hook, call) =>
          makeThreadState({ ...base, scope: promptScope(turn), from: hook.definition, invoke: noInvoke, call }),
      }
      const base = {
        thread,
        services,
        execution,
        context,
        secrets,
        hooks,
      }
      const write = { threadId, hooks, secrets, call: undefined }
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
        invoke: noInvoke,
      })
      // A scripted run still learns the secret values of the model's real provider config.
      yield* learnSecrets(turn, secrets)
      const provider =
        options.provider === undefined
          ? yield* providerFor(turn.model, promptState, secrets)
          : Effect.succeed(options.provider)
      const source = reasoningSource(turn)
      const acceptsDetails = (message: Message) => {
        const stored = message.metadata?.reasoning_source as Partial<typeof source> | null | undefined
        return stored?.definition === source.definition && stored?.model === source.model
      }
      const prompt = turn.prompt.value
      const view = {
        side: turn.side,
        past: pastOf(atStart, turn.side),
        includeChat: prompt.includeChat === true,
        includePastTools: prompt.includePastTools === true,
        includeReasoning: prompt.reasoning?.include !== false,
        acceptsDetails,
      }
      // Hooks section 5. A call that started in a response the loop then discarded is done too, and never ran.
      const streamed: StreamedCalls | undefined =
        has(hooks, "tool_call_started") || has(hooks, "tool_call_done")
          ? {
              progressArgument: (name) => turn.tools.get(name)?.tool.value.progressArgument,
              started: (call, progress) =>
                runHooks(hooks, "tool_call_started", [hookCall(call, call.argumentsText)], progress),
              abandoned: (calls) =>
                Effect.forEach(
                  calls,
                  (call) =>
                    runHooks(hooks, "tool_call_done", [hookCall(call, call.argumentsText)], {
                      status: "error",
                      error: "Spindle did not run this call, because the model response that held it failed.",
                    }),
                  { discard: true },
                ),
            }
          : undefined
      while (true) {
        step += 1
        yield* record("drain", "no queue before M1-6")
        // Runtime section 4 orders the seven steps of an assembly.
        const rendered = yield* renderSystemPrompt(turn, secrets)
        yield* record("assemble", "interpolate the system prompt")
        const system = yield* runHooks(hooks, "after_system_message", [], rendered)
        yield* checkSystemPrompt(turn, system, secrets)
        yield* record("assemble", `after_system_message, ${countHooks(hooks, "after_system_message")} hooks`)
        // Runtime section 4: the snapshot is the persisted history at the moment filter_messages starts, whoever
        // wrote it. A message written later belongs to the next assembly.
        const snapshot = yield* readHistory
        yield* record("assemble", `snapshot, ${snapshot.length} messages`)
        const filtered = yield* runHooks(hooks, "filter_messages", [], snapshot)
        yield* record("assemble", `filter_messages, ${countHooks(hooks, "filter_messages")} hooks`)
        const transformed = toProviderMessages(filtered, view)
        yield* record("assemble", `transform, ${transformed.length} provider messages`)
        const prefiltered = has(hooks, "prefilter_llm_history")
          ? (yield* runHooks(hooks, "prefilter_llm_history", [], transformed.map(toLLMMessage))).map(fromLLMMessage)
          : transformed
        // Messages section 1.3: a prompt that sets reasoning.include to false sends no reasoning, whatever a hook
        // put back.
        const messages = view.includeReasoning ? prefiltered : prefiltered.map(withoutReasoning)
        yield* record("assemble", `prefilter_llm_history, ${countHooks(hooks, "prefilter_llm_history")} hooks`)
        const request = buildRequest(turn, system, messages, abort.signal)
        yield* record("assemble", `dispatch, ${request.messages.length} messages, ${request.tools?.length ?? 0} tools`)
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
            ...(streamed === undefined ? {} : { streamed }),
          },
          request,
        )
        steps += 1
        execution.stepCount += 1
        if (turn.side === "a") execution.sideAStepCount += 1
        else execution.sideBStepCount += 1
        const calls = toolCallsOf(response)
        const assistant = yield* createMessage(write, responseMessage(turn, response, calls), "turn")
        yield* record("persist-response", `${assistant.id}, ${calls.length} tool calls`)
        yield* observe({ type: "message", message: assistant })
        if (calls.length === 0) {
          yield* record("tools", "none")
          yield* record("persist-results", "none")
        }
        const results: Array<ToolResult> = []
        for (const call of calls) {
          yield* record("tools", `${call.name} ${call.id}`)
          const returned = yield* runToolCall(toolContext, call)
          // Hooks section 5: the branch the tool's own outcome picks, then before_store_tool_result, then the
          // stored message, then tool_call_done with what was stored.
          const toolCall = hookCall(call, argumentsOf(call))
          const branched = yield* runHooks(
            hooks,
            returned.status === "success" ? "after_tool_call_success" : "after_tool_call_failure",
            [toolCall],
            returned,
          )
          const final = yield* runHooks(hooks, "before_store_tool_result", [toolCall], branched)
          const save = (result: ToolResult) =>
            Effect.gen(function* () {
              const { redacted, message } = yield* Effect.try({
                try: () => ({
                  redacted: redactResult(result, redact),
                  message: storedResult(turn, call, result),
                }),
                catch: (cause) => new ResultUnreadable({ message: `reading it threw: ${describe(cause)}` }),
              })
              return { redacted, stored: yield* createMessage(write, message, "result") }
            })
          // Runtime section 5.2: a failure between the tool's return and its stored result fails this one call.
          const { redacted: result, stored } = yield* save(final).pipe(
            Effect.catchTag(["ValueNotJson", "ResultUnreadable", "MessageIdTaken"], (error) =>
              save(unstorableResult(final, error.message)),
            ),
          )
          // Storing a result can turn a success into an error, and the stop tool outcome reports what was stored.
          results.push(stored.tool_status == null ? final : { ...final, status: stored.tool_status })
          yield* record("persist-results", `${call.id} ${stored.tool_status}`)
          yield* observe({ type: "message", message: stored })
          yield* runHooks(hooks, "tool_call_done", [toolCall], result)
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
          const stopTool = reason === "stop_tool" ? stopToolOutcome(turn, calls, results, redact) : undefined
          return yield* settle("idle", reason, stopTool === undefined ? {} : { stopTool })
        }
      }
    })

    return yield* loop.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        const found = Cause.findError(cause)
        if (found._tag === "Failure")
          return settle("failed", "fatal_error", { error: { message: describeCause(cause) } })
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
