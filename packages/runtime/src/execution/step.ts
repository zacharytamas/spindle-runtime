import type { LLMProviderInterface, Message, ProviderRequest, ToolResult } from "@standardagents/spec"
import { type Context, Effect, Fiber, Result } from "effect"
import { providerFor, resolveConfig } from "../providers/config.ts"
import type { Registry } from "../registry/Registry.ts"
import { MessageStore } from "../store/MessageStore.ts"
import type { Thread } from "../store/model.ts"
import { RunStore } from "../store/RunStore.ts"
import type { Stores } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import { assembleRequest, type HistoryView, promptScope } from "./assemble.ts"
import { type CallContext, callModel, type ModelCall, type ModelResponse } from "./call.ts"
import { drainQueue, queueRecipient } from "./drain.ts"
import type { End, Execution } from "./Execution.ts"
import { addSecret, instanceEnv, lookupEnv, newSecrets, type Secrets } from "./env.ts"
import { type HandlerCall, HandlerDeliveries, handlerTurn } from "./handler.ts"
import { type History, makeHistory } from "./history.ts"
import { agentHooks, type HookScope, turnHooks } from "./hooks.ts"
import { commitMessage, type WriteContext } from "./messages.ts"
import { mapStrings, redactor } from "./redact.ts"
import { reasoningSource, responseCalls, responseMessage, stopToolOutcome } from "./response.ts"
import { stopReason } from "./stop-rules.ts"
import { agentHookScope, makeThreadState, type ThreadControl } from "./thread-state.ts"
import { completeCall, streamedHooks } from "./tool-lifecycle.ts"
import { invokeTool, runToolCall, scopeFor, type ToolContext } from "./tools.ts"
import type { Phase, TraceEntry } from "./trace.ts"
import {
  type AgentSides,
  type AutomatedSide,
  type HandlerSideValue,
  loadAgent,
  otherSide,
  type PromptSideValue,
  prepareSideValue,
  type SideValue,
} from "./turn.ts"

export type ExecutionEvent =
  | { readonly type: "trace"; readonly entry: TraceEntry }
  | { readonly type: "message"; readonly message: Message; readonly handlerOutput?: boolean }
  | { readonly type: "request"; readonly request: ProviderRequest }

export interface ToolScope<T extends AutomatedSide = AutomatedSide> {
  readonly turn: T
  readonly write: WriteContext
  readonly toolContext: ToolContext<T>
}

export interface SideScope extends ToolScope<PromptSideValue> {
  readonly view: HistoryView
  readonly provider: CallContext["provider"]
  readonly streamed: CallContext["streamed"]
}

export interface ThreadScope {
  readonly deliveries: HandlerDeliveries
  readonly handlerCalls: Array<HandlerCall>
  readonly sides: AgentSides
  readonly context: Record<string, unknown>
  readonly thread: Thread
  readonly services: Context.Context<Registry | Stores>
  readonly control: ThreadControl
  readonly secrets: Secrets
  readonly run: Execution
  readonly history: History
  readonly executionStartSeq: number
  readonly delivery: WriteContext
  readonly counter: { step: number }
  readonly modelCalls: Array<ModelCall>
  readonly pending: Array<Fiber.Fiber<void>>
  readonly redact: (text: string) => string
  record: (phase: Phase, detail: string) => Effect.Effect<void>
  observe: (event: ExecutionEvent) => Effect.Effect<void>
}

export interface ExecutionOptions {
  readonly onHold?: (operation: string) => Effect.Effect<void>
  readonly toolTimeout?: ToolContext["toolTimeout"]
  readonly retries?: number
  readonly turnCap?: number
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
  readonly handlerCalls: ReadonlyArray<HandlerCall>
  readonly trace: ReadonlyArray<TraceEntry>
  readonly modelCalls: ReadonlyArray<ModelCall>
}

// Before the first request, and before spindle run prints a line, the execution learns every secret value that the
// turn can resolve: the provider config's, each value of a name marked secret, and the instance value of each
// variable that the prompt or one of its tools declares.
const secretScopes = (turn: PromptSideValue) => [
  { scope: promptScope(turn), variables: turn.prompt.value.variables ?? [] },
  ...[...turn.tools.values()].map(({ tool, entry }) => ({
    scope: scopeFor(turn, entry),
    variables: tool.value.variables ?? [],
  })),
]

const readable = <A, E>(read: Effect.Effect<A | undefined, E>) => Effect.orElseSucceed(read, () => undefined)

export const prepareSides = Effect.fn("prepareSides")(function* (agent: AgentSides["agent"], secrets: Secrets) {
  const a = yield* Effect.result(prepareSideValue(agent, "a"))
  const b = yield* Effect.result(prepareSideValue(agent, "b"))
  const prompts = [Result.getOrUndefined(a), Result.getOrUndefined(b)].filter((side) => side?.kind === "prompt")
  const scopes = prompts.flatMap(secretScopes)
  for (const turn of prompts) yield* resolveConfig(turn.model, secrets, (name: string) => readable(instanceEnv(name)))
  for (const { variables } of scopes)
    for (const variable of variables) if (variable.type === "secret") secrets.names.add(variable.name)

  for (const { variables, scope } of scopes) {
    const names = new Set([...secrets.names, ...variables.map((variable) => variable.name)])
    for (const name of names) {
      const found = yield* readable(lookupEnv(scope, name))
      if (found !== undefined && (found.fromInstance || secrets.names.has(name))) addSecret(secrets, found.value)
      // A definition can hide a different instance value, which still belongs to the operator.
      const instance = yield* readable(instanceEnv(name))
      if (instance !== undefined && instance !== found?.value) addSecret(secrets, instance)
    }
  }
  return { agent, a: yield* Effect.fromResult(a), b: yield* Effect.fromResult(b) } satisfies AgentSides
})

function stepLog(threadId: string, run: Execution, secrets: Secrets, options: ExecutionOptions) {
  const flowId = run.flowId
  const handlerCalls: Array<HandlerCall> = []
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
      const plain: Record<string, unknown> = JSON.parse(JSON.stringify(data))
      return mapStrings(plain, redact, redact)
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

  const report = (end: End, brief: boolean) =>
    Effect.gen(function* () {
      if (!brief) yield* Effect.forEach(pending, Fiber.join, { concurrency: 1, discard: true })
      const calls = brief
        ? []
        : modelCalls.map((call) => ({
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
        trace: brief ? [] : trace,
        modelCalls: calls,
        handlerCalls: handlerCalls.map((call) => (call.error ? { ...call, error: redactError(call.error) } : call)),
      } satisfies RunOutcome
    })

  return { record, observe, report, handlerCalls, modelCalls, pending, counter, redact }
}

const prepareToolContext = Effect.fnUntraced(function* <T extends AutomatedSide>(
  thread: ThreadScope,
  turn: T,
  hooks: HookScope,
  options: ExecutionOptions,
) {
  const toolContext: ToolContext<T> = {
    execution: thread.run,
    scope: yield* Effect.scope,
    toolTimeout: options.toolTimeout,
    turn,
    stateFor: (tool, entry, callback) =>
      makeThreadState({
        ...thread,
        execution: { history: thread.history, run: thread.run },
        hooks,
        scope: scopeFor(turn, entry),
        from: tool,
        caller: tool,
        callback,
        invoke: (name, args, onExecute) =>
          invokeTool(toolContext, tool, tool, name, args, onExecute).pipe(Effect.provideContext(thread.services)),
      }),
  }
  return toolContext
})

const prepareSide = Effect.fnUntraced(function* (
  thread: ThreadScope,
  turn: PromptSideValue,
  options: ExecutionOptions,
) {
  const { run, history, secrets } = thread
  const cached = run.turns.scopes.get(turn)
  if (cached) return cached
  const hooks: HookScope = {
    execution: run,
    set: yield* turnHooks(turn),
    stateFor: (hook, call) => makeThreadState({ ...base, scope: promptScope(turn), from: hook.definition, call }),
  }
  const base = {
    ...thread,
    execution: { history, run },
    hooks,
  }
  const write = { ...thread.delivery, hooks }
  const toolContext = yield* prepareToolContext(thread, turn, hooks, options)
  const promptState = makeThreadState({
    ...base,
    scope: promptScope(turn),
    from: turn.prompt,
  })
  const configured =
    options.provider === undefined
      ? yield* providerFor(turn.model, promptState, secrets)
      : { lifetime: "shared" as const, provider: options.provider }
  const provider = configured.lifetime === "shared" ? Effect.succeed(configured.provider) : configured.build
  const scope = {
    turn,
    write,
    toolContext,
    provider,
    view: historyView(turn, thread.executionStartSeq),
    streamed: streamedHooks(hooks, turn),
  } satisfies SideScope
  run.turns.scopes.set(turn, scope)
  return scope
})

function historyView(turn: PromptSideValue, turnStartSeq: number) {
  const source = reasoningSource(turn)
  const acceptsDetails = (message: Message) => {
    const stored = message.metadata?.reasoning_source as Partial<typeof source> | null | undefined
    return stored?.definition === source.definition && stored?.model === source.model
  }
  const prompt = turn.prompt.value
  return {
    side: turn.side,
    turnStartSeq,
    includeChat: prompt.includeChat === true,
    includePastTools: prompt.includePastTools === true,
    includeReasoning: prompt.reasoning?.include !== false,
    acceptsDetails,
  }
}

const storeResponse = Effect.fnUntraced(function* (side: SideScope, thread: ThreadScope, response: ModelResponse) {
  const { toolContext, turn, write } = side
  const { run, record, observe } = thread
  const calls = responseCalls(response)
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
    results.push(yield* completeCall(side, thread, seq, call, runToolCall(toolContext, call)))
  }
  return { calls, results }
})

const promptStep = Effect.fnUntraced(function* (side: SideScope, thread: ThreadScope, retries: number) {
  const { turn, provider, streamed } = side
  const { run, counter, record } = thread
  const request = yield* assembleRequest(side, thread)
  if (!request) return undefined
  const response = yield* callModel(
    {
      provider,
      retries,
      calls: thread.modelCalls,
      pending: thread.pending,
      step: counter.step,
      stopped: () => run.stopAtBoundary() !== undefined,
      waitForStop: run.waitForStop,
      record: (detail: string) => record("call", detail),
      toolChoice: turn.prompt.value.toolChoice,
      ...(streamed && { streamed }),
    },
    request,
  )
  if (!response) return undefined
  run.recordStep(turn.side)
  return { response, ...(yield* storeResponse(side, thread, response)) }
})

const idle = (reason: string, continueIfQueued = false): End => ({ status: "idle", reason, continueIfQueued })

// A completed prompt turn advances the durable counter. A human destination goes
// through the store's atomic queue check so admission racing settlement cannot lose a wakeup.
const afterStep = Effect.fnUntraced(function* (
  side: SideScope,
  thread: ThreadScope,
  step: NonNullable<Effect.Success<ReturnType<typeof promptStep>>>,
  sideSteps: number,
  options: ExecutionOptions,
) {
  const { run, sides } = thread
  const stepCap = options.stepCap ?? 1000
  const forced = run.turns.takeTarget()
  const { calls, results, response } = step
  const progress = { text: response.content, calls, sideSteps, totalSteps: run.steps }
  const reason = forced === undefined ? stopReason(progress, side.turn.config, stepCap) : "force_turn"
  if (reason === undefined) return undefined
  if (reason === "max_total_steps") return idle(reason)
  const sessionEnd = yield* run.completeTurn(
    thread.thread.id,
    side.view,
    sides.agent.value.maxSessionTurns,
    options.turnCap ?? 1000,
  )
  if (sessionEnd) return sessionEnd
  const next = sides[forced ?? otherSide(side.turn.side)]
  if (next.kind === "human") {
    const stopTool = reason === "stop_tool" ? stopToolOutcome(side.turn, calls, results, thread.redact) : undefined
    return { ...idle(reason === "force_turn" ? "forced_human_turn" : reason, true), ...(stopTool && { stopTool }) }
  }
  if (run.steps >= stepCap) return idle("max_total_steps")
  return { next, reason }
})

const promptTurn = Effect.fnUntraced(function* (
  side: SideScope,
  thread: ThreadScope,
  options: ExecutionOptions,
  handoff: boolean,
) {
  const { run, record } = thread
  let steps = 0
  while (true) {
    thread.counter.step++
    if (run.stopAtBoundary()) return run.abortEnd
    const prompted = yield* drainQueue(side, thread)
    if (run.stopAtBoundary()) return run.abortEnd
    if (steps === 0 && !handoff && !prompted) return idle("awaiting_human", true)
    const step = yield* promptStep(side, thread, options.retries ?? 2)
    if (!step || run.stopAtBoundary()) return run.abortEnd
    const boundary = yield* afterStep(side, thread, step, ++steps, options)
    if (boundary) return boundary
    yield* record("stop", "continue")
  }
})

const prepareHandler = Effect.fnUntraced(function* (
  thread: ThreadScope,
  turn: HandlerSideValue,
  options: ExecutionOptions,
) {
  const cached = thread.run.turns.handlerScopes.get(turn)
  if (cached) return cached
  const write = thread.delivery
  const scope = { turn, write, toolContext: yield* prepareToolContext(thread, turn, write.hooks, options) }
  thread.run.turns.handlerScopes.set(turn, scope)
  return scope
})

// A new run takes the destination of its FIFO head. Work addressed to a human
// is delivered by the automated peer, which can then park without calling a model.
const advance = Effect.fnUntraced(function* (thread: ThreadScope, options: ExecutionOptions) {
  const { run, sides } = thread
  const head = yield* (yield* RunStore).nextQueued(thread.thread.id, run)
  run.turns.active = queueRecipient(sides, head)
  let reason = "queue"
  while (true) {
    if (run.stopAtBoundary()) return run.abortEnd
    const active: SideValue = run.turns.active
    if (active.kind === "human") return idle("awaiting_human")
    let boundary: End | { next: SideValue; reason: string }
    if (active.kind === "handler") {
      const side: ToolScope<HandlerSideValue> = yield* prepareHandler(thread, active, options)
      boundary = yield* handlerTurn(side, thread, reason === "force_turn", options.turnCap ?? 1000)
    } else {
      const side: SideScope = yield* prepareSide(thread, active, options)
      const peer = sides[otherSide(active.side)]
      thread.deliveries.begin(peer.kind === "handler" ? active.role : undefined)
      boundary = yield* promptTurn(side, thread, options, reason !== "queue")
      thread.deliveries.finish(peer, "next" in boundary)
    }
    run.turns.pending = undefined
    yield* thread.record("stop", boundary.reason)
    if (!("next" in boundary)) return boundary
    run.turns.active = boundary.next
    reason = boundary.reason
  }
})

export const prepareSteps = Effect.fnUntraced(function* (
  threadId: string,
  run: Execution,
  control: ThreadControl,
  options: ExecutionOptions,
) {
  const secrets = newSecrets(options.secrets)
  const log = stepLog(threadId, run, secrets, options)
  const stepCap = options.stepCap ?? 1000
  const setup = yield* Effect.cached(
    Effect.gen(function* () {
      const executionStartSeq = (yield* (yield* MessageStore).latestMessageSeq(threadId)) + 1
      const thread = yield* (yield* ThreadStore).getThread(threadId)
      const services = yield* Effect.context<Registry | Stores>()
      const sides = yield* prepareSides(yield* loadAgent(thread.agentId), secrets)
      const deliveries = new HandlerDeliveries()
      const history = makeHistory(threadId, {
        onInsert: (row) => deliveries.inserted(row),
        onUpdate: (message) => deliveries.updated(message),
        onDelete: (messageId) => deliveries.deleted(messageId),
      })
      const base = { thread, services, secrets, control, history, run, sides, context: {} }
      // Inbound delivery uses the agent's hooks and environment inside the flow taking the message.
      const hooks = agentHookScope(
        {
          ...base,
          owner: run,
          execution: { history, run },
          scope: { agent: sides.agent.value.env, toolEntry: undefined, prompt: undefined },
        },
        yield* agentHooks(sides.agent),
      )
      const delivery: WriteContext = {
        threadId,
        hooks,
        secrets,
        call: undefined,
        history,
        origin: { kind: "flow", flowId: run.flowId },
      }
      const scope: ThreadScope = { ...base, ...log, delivery, deliveries, executionStartSeq }
      return scope
    }),
  )
  return { advance: Effect.flatMap(setup, (scope) => advance(scope, options)), report: log.report, stepCap }
})
