import type { LLMProviderInterface, Message, ProviderRequest, ToolResult } from "@standardagents/spec"
import { Effect, Fiber } from "effect"
import { providerFor, resolveConfig } from "../providers/config.ts"
import type { Registry } from "../registry/Registry.ts"
import type { Stores } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import { assembleRequest, pastOf, promptScope } from "./assemble.ts"
import { callModel, type ModelCall, type ModelResponse } from "./call.ts"
import { drainQueue } from "./drain.ts"
import type { End, Execution } from "./Execution.ts"
import { addSecret, instanceEnv, lookupEnv, newSecrets, type Secrets } from "./env.ts"
import { makeHistory } from "./history.ts"
import { agentHooks, type HookScope, turnHooks } from "./hooks.ts"
import { commitMessage } from "./messages.ts"
import { mapStrings, redactor } from "./redact.ts"
import { reasoningSource, responseMessage, stopToolOutcome, toolCallsOf } from "./response.ts"
import { stopReason } from "./stop-rules.ts"
import { atRestHooks, makeThreadState, type ThreadControl } from "./thread-state.ts"
import { completeCall, streamedHooks } from "./tool-lifecycle.ts"
import { invokeTool, runToolCall, scopeFor, type ToolContext } from "./tools.ts"
import type { Phase, TraceEntry } from "./trace.ts"
import { prepareTurn, type Turn } from "./turn.ts"

export type ExecutionEvent =
  | { readonly type: "trace"; readonly entry: TraceEntry }
  | { readonly type: "message"; readonly message: Message }
  | { readonly type: "request"; readonly request: ProviderRequest }
  // The message entered the queue of an execution that another process runs.
  | { readonly type: "queued"; readonly threadId: string; readonly pid: number | null }
  | { readonly type: "interrupted_while_queued" }

export interface StepEvents {
  record: (phase: Phase, detail: string) => Effect.Effect<void>
  observe: (event: ExecutionEvent) => Effect.Effect<void>
}

export interface ExecutionOptions {
  readonly retries?: number
  readonly stepCap?: number
  readonly provider?: LLMProviderInterface
  // The execution adds each secret value it resolves, so that a caller can redact what it prints.
  readonly secrets?: Set<string>
  readonly observe?: (event: ExecutionEvent) => Effect.Effect<void>
}

interface RunError {
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

function stepLog(threadId: string, run: Execution, secrets: Secrets, options: ExecutionOptions) {
  const flowId = run.flowId
  const trace: Array<TraceEntry> = []
  const modelCalls: Array<ModelCall> = []
  const pending: Array<Fiber.Fiber<void>> = []
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
  const counter = { step: 0 }

  const record = (phase: Phase, detail: string) => {
    const entry: TraceEntry = { step: counter.step, phase, detail: redact(detail) }
    trace.push(entry)
    return observe({ type: "trace", entry })
  }

  const report = (end: End) =>
    Effect.gen(function* () {
      yield* Effect.forEach(pending, Fiber.join, { concurrency: 1, discard: true })
      const calls = modelCalls.map((call) => ({
        ...call,
        ...(call.error === undefined ? {} : { error: redactError(call.error) }),
        ...(call.metadataError === undefined ? {} : { metadataError: redact(call.metadataError) }),
        ...(call.metadata == null ? {} : { metadata: redactLog(call.metadata) }),
      }))
      return {
        threadId,
        flowId,
        status: end.status,
        reason: end.reason,
        steps: run.steps,
        ...(end.stopTool === undefined ? {} : { stopTool: end.stopTool }),
        ...(end.error === undefined ? {} : { error: redactError(end.error) }),
        trace,
        modelCalls: calls,
      } satisfies RunOutcome
    })

  return { record, observe, report, modelCalls, pending, counter, redact }
}

const prepareSession = Effect.fnUntraced(function* (
  threadId: string,
  run: Execution,
  control: ThreadControl,
  secrets: Secrets,
  options: ExecutionOptions,
) {
  const thread = yield* (yield* ThreadStore).getThread(threadId)
  const services = yield* Effect.context<Registry | Stores>()
  const turn = yield* prepareTurn(thread.agentId)
  const hookSet = yield* turnHooks(turn)
  const history = makeHistory(threadId)
  const context: Record<string, unknown> = {}
  const hooks: HookScope = {
    execution: run,
    set: hookSet,
    stateFor: (hook, call) => makeThreadState({ ...base, scope: promptScope(turn), from: hook.definition, call }),
  }
  const base = {
    thread,
    services,
    execution: {
      side: turn.side,
      promptPath: [turn.prompt.definition.qualifiedName],
      history,
      run,
    },
    context,
    secrets,
    hooks,
    control,
  }
  const write = {
    threadId,
    hooks,
    secrets,
    call: undefined,
    history,
    origin: { kind: "flow" as const, flowId: run.flowId },
  }
  // Hooks section 1.3: a message that arrives from outside, the human's included, does not belong to the prompt's
  // turn. The agent's hooks apply to it and see no execution, as they do at rest.
  const inbound = atRestHooks(
    {
      thread,
      services,
      secrets,
      control,
      owner: run,
      scope: { agent: turn.agent.value.env, toolEntry: undefined, prompt: undefined },
    },
    yield* agentHooks(turn.agent),
  )
  const delivery = { ...write, hooks: inbound }
  const toolContext: ToolContext = {
    execution: run,
    turn,
    stateFor: (tool, entry, callback) =>
      makeThreadState({
        ...base,
        scope: scopeFor(turn, entry),
        from: tool.definition,
        caller: tool,
        callback,
        invoke: (name, args) => invokeTool(toolContext, tool, name, args).pipe(Effect.provideContext(services)),
      }),
  }
  const promptState = makeThreadState({
    ...base,
    scope: promptScope(turn),
    from: turn.prompt.definition,
  })
  // A scripted run still learns the secret values of the model's real provider config.
  yield* learnSecrets(turn, secrets)
  const configured =
    options.provider === undefined
      ? yield* providerFor(turn.model, promptState, secrets)
      : { lifetime: "shared" as const, provider: options.provider }
  const provider = configured.lifetime === "shared" ? Effect.succeed(configured.provider) : configured.build
  return { turn, history, write, delivery, toolContext, provider }
})

function historyView(turn: Turn) {
  const source = reasoningSource(turn)
  const acceptsDetails = (message: Message) => {
    const stored = message.metadata?.reasoning_source as Partial<typeof source> | null | undefined
    return stored?.definition === source.definition && stored?.model === source.model
  }
  const prompt = turn.prompt.value
  return {
    side: turn.side,
    past: new Set<string>(),
    includeChat: prompt.includeChat === true,
    includePastTools: prompt.includePastTools === true,
    includeReasoning: prompt.reasoning?.include !== false,
    acceptsDetails,
  }
}

const storeResponse = Effect.fnUntraced(function* (session: Session, response: ModelResponse, events: StepEvents) {
  const { toolContext, turn, write } = session
  const { record, observe } = events
  const run = toolContext.execution
  const calls = toolCallsOf(response)
  const { message: assistant, seq } = yield* commitMessage(write, responseMessage(turn, response, calls))
  yield* record("persist-response", `${assistant.id}, ${calls.length} tool calls`)
  yield* observe({ type: "message", message: assistant })
  if (calls.length === 0) {
    yield* record("tools", "none")
    yield* record("persist-results", "none")
  }
  const results: Array<ToolResult> = []
  for (const call of calls) {
    // A call after a stop request never runs. It still gets a result, so that the next request is valid.
    const skipped = run.stopAtBoundary()
    yield* record("tools", `${call.name} ${call.id}${skipped ? " not run" : ""}`)
    results.push(yield* completeCall(toolContext, write, events, seq, call, runToolCall(toolContext, call)))
  }
  return { calls, results }
})

type Session = Effect.Success<ReturnType<typeof prepareSession>>

function advance(session: Session, events: ReturnType<typeof stepLog>, retries: number, stepCap: number) {
  const { turn, history, write, delivery, toolContext, provider } = session
  const run = toolContext.execution
  const { record, modelCalls, pending, counter, redact } = events
  let view = historyView(turn)
  const streamed = streamedHooks(write.hooks, turn)
  const model = {
    provider,
    stopped: () => run.stopAtBoundary() !== undefined,
    retries,
    calls: modelCalls,
    pending,
    record: (detail: string) => record("call", detail),
    ...(streamed && { streamed }),
  }
  const drain = drainQueue(toolContext, write, delivery, events)
  // Execution State section 3: a stop takes effect at the boundary between two operations. The run settles idle,
  // and the work still queued waits for the next trigger.
  const recordStop = (end: End) => Effect.as(record("stop", end.reason), end)
  let turnStart = true
  let turnSteps = 0
  return Effect.gen(function* () {
    while (true) {
      counter.step += 1
      const beforeDrain = run.stopAtBoundary()
      if (beforeDrain) return yield* recordStop(beforeDrain)
      const { prompted, first, count } = yield* drain
      const afterDrain = run.stopAtBoundary()
      if (afterDrain) return yield* recordStop(afterDrain)
      if (turnStart) {
        // Runtime section 3: with nothing for the prompt side to act on, the turn is the human's.
        if (!prompted) {
          yield* record("stop", "awaiting_human")
          return { status: "idle", reason: "awaiting_human", continueIfQueued: true } satisfies End
        }
        // The turn starts at the other side's latest message, and everything before it is past history.
        view = {
          ...view,
          past: pastOf(
            (yield* history.read).rows.map((row) => row.message),
            turn.side,
            count > 1 ? first : undefined,
          ),
        }
        turnStart = false
        turnSteps = 0
      }
      const request = yield* assembleRequest(turn, view, history, write, run, events)
      if (!request) return yield* recordStop(run.abortEnd)
      const response = yield* callModel(
        { ...model, step: counter.step, toolChoice: turn.prompt.value.toolChoice },
        request,
      )
      if (response === undefined) return yield* recordStop(run.abortEnd)
      run.recordStep()
      turnSteps += 1
      const { calls, results } = yield* storeResponse(session, response, events)
      const afterTools = run.stopAtBoundary()
      if (afterTools) return yield* recordStop(afterTools)
      // maxSteps counts the side's model steps in one turn, and the runtime cap counts every step of the execution.
      const progress = { text: response.content, calls, sideSteps: turnSteps, totalSteps: run.steps }
      const reason = stopReason(progress, turn.config, stepCap)
      yield* record("stop", reason ?? "continue")
      if (reason !== undefined) {
        const stopTool = reason === "stop_tool" ? stopToolOutcome(turn, calls, results, redact) : undefined
        // The runtime cap ends the execution even while the queue holds work, so that queued work cannot keep one
        // execution going without end.
        turnStart = true
        return {
          status: "idle",
          reason,
          continueIfQueued: reason !== "max_total_steps",
          ...(stopTool && { stopTool }),
        } satisfies End
      }
    }
  })
}

export const prepareSteps = Effect.fnUntraced(function* (
  threadId: string,
  run: Execution,
  control: ThreadControl,
  options: ExecutionOptions,
) {
  const secrets = newSecrets(options.secrets)
  const log = stepLog(threadId, run, secrets, options)
  const retries = options.retries ?? 2
  const stepCap = options.stepCap ?? 1000
  const setup = yield* Effect.cached(
    Effect.map(prepareSession(threadId, run, control, secrets, options), (session) =>
      advance(session, log, retries, stepCap),
    ),
  )
  return { advance: Effect.flatten(setup), report: log.report, stepCap }
})
