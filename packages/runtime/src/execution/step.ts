import type {
  AttachmentRef,
  HookToolCall,
  LLMProviderInterface,
  Message,
  PromptToolConfig,
  ProviderRequest,
  QueueMessageInput,
  ThreadState,
  ToolResult,
} from "@standardagents/spec"
import { Cause, Effect, Fiber } from "effect"
import { providerFor, resolveConfig } from "../providers/config.ts"
import { Registry } from "../registry/Registry.ts"
import type { NewMessage, Queued, Settlement } from "../store/model.ts"
import { RunStore } from "../store/RunStore.ts"
import type { Stores } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import {
  buildRequest,
  checkSystemMessages,
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
import type { Callback } from "./callback.ts"
import { addSecret, instanceEnv, lookupEnv, newSecrets, type Secrets } from "./env.ts"
import { makeHistory } from "./history.ts"
import { agentHooks, countHooks, type HookScope, has, runHooks, turnHooks } from "./hooks.ts"
import { createMessage } from "./messages.ts"
import { mapStrings, redactor } from "./redact.ts"
import { CLOSING } from "./run-status.ts"
import { stopReason } from "./stop-rules.ts"
import { type ExecutionRecord, makeThreadState, type Run, type ThreadControl } from "./thread-state.ts"
import {
  describe,
  executeTool,
  failed,
  invokeTool,
  notRun,
  ResultUnreadable,
  resultOf,
  runToolCall,
  scopeFor,
  storedResult,
  type ToolCall,
  type ToolContext,
  unstorableResult,
} from "./tools.ts"
import type { Phase, TraceEntry } from "./trace.ts"
import { type FunctionTool, isFunctionTool, type Loaded, prepareTurn, roleOf, type Turn } from "./turn.ts"

export type ExecutionEvent =
  | { readonly type: "trace"; readonly entry: TraceEntry }
  | { readonly type: "message"; readonly message: Message }
  | { readonly type: "request"; readonly request: ProviderRequest }
  // The message entered the queue of an execution that another process runs.
  | { readonly type: "queued"; readonly threadId: string; readonly pid: number | null }
  | { readonly type: "interrupted_while_queued" }

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

// Messages section 4: a queued message is stored with its own perspective and payload. Admission let only attachment
// references through.
const draftOf = (input: QueueMessageInput): NewMessage => ({
  role: input.role,
  content: input.content,
  status: "completed",
  ...(input.silent === undefined ? {} : { silent: input.silent }),
  ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  ...((input.attachments ?? []).length === 0 ? {} : { attachments: input.attachments as Array<AttachmentRef> }),
})

export const runExecution = (threadId: string, run: Run, control: ThreadControl, options: ExecutionOptions = {}) =>
  Effect.gen(function* () {
    const runStore = yield* RunStore
    const threadStore = yield* ThreadStore
    const registry = yield* Registry
    const services = yield* Effect.context<Registry | Stores>()
    const retries = options.retries ?? DEFAULT_RETRIES
    const stepCap = options.stepCap ?? DEFAULT_STEP_CAP
    const flowId = run.flowId
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
    const abort = run.abort
    let step = 0
    let steps = 0

    const record = (phase: Phase, detail: string) => {
      const entry: TraceEntry = { step, phase, detail: redact(detail) }
      trace.push(entry)
      return observe({ type: "trace", entry })
    }

    // Execution State section 4.3: every run settles. A run that ended its turn goes on while the queue holds work.
    // Once the run settles, every ThreadState of the execution refuses its calls.
    const release = (state: RunOutcome["status"], reason: string, continueIfQueued: boolean, closing: string) =>
      Effect.tap(
        runStore.settle(
          threadId,
          { flowId },
          { state, reason },
          { continueIfQueued, closing, atCap: steps >= stepCap },
        ),
        (settlement) =>
          Effect.sync(() => {
            if (settlement !== "continue") run.ended = true
          }),
      )

    const settle = (
      status: RunOutcome["status"],
      reason: string,
      extra: { readonly error?: RunError; readonly stopTool?: StopToolOutcome } = {},
    ) =>
      Effect.gen(function* () {
        yield* Effect.forEach(pending, Fiber.join, { concurrency: 1, discard: true })
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

    // A run that another process settled, as lost, or that terminate settled reports the status the store holds.
    const ended = (
      settlement: Settlement,
      status: RunOutcome["status"],
      reason: string,
      extra: { readonly error?: RunError; readonly stopTool?: StopToolOutcome } = {},
    ) =>
      settlement === "superseded"
        ? Effect.flatMap(threadStore.getThread(threadId), (thread) =>
            thread.terminated === null ? settle("failed", "execution_lost") : settle("idle", "aborted"),
          )
        : settlement === "capped"
          ? settle("idle", "max_total_steps")
          : settle(status, reason, extra)

    const loop = Effect.gen(function* () {
      const thread = yield* threadStore.getThread(threadId)
      const turn = yield* prepareTurn(thread.agentId)
      const hookSet = yield* turnHooks(turn)
      const history = makeHistory(threadId)
      const execution: ExecutionRecord = {
        flowId,
        side: turn.side,
        stepCount: 0,
        sideAStepCount: 0,
        sideBStepCount: 0,
        abort,
        promptPath: [turn.prompt.definition.qualifiedName],
        history,
        run,
      }
      const context: Record<string, unknown> = {}
      const noInvoke = (name: string) =>
        Effect.succeed<ToolResult>({
          status: "error",
          error: `invokeTool(${name}) needs a calling tool and its uses list`,
        })
      const hooks: HookScope = {
        pending: run.pending,
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
        control,
      }
      const write = { threadId, hooks, secrets, call: undefined, history, origin: { flowId } }
      // Hooks section 1.3: a message that arrives from outside, the human's included, does not belong to the prompt's
      // turn. The agent's hooks apply to it and see no execution, as they do at rest.
      const inbound: HookScope = {
        pending: run.pending,
        set: yield* agentHooks(turn.agent),
        stateFor: (hook, call) =>
          makeThreadState({
            ...base,
            owner: run,
            execution: undefined,
            context: {},
            scope: { agent: turn.agent.value.env, toolEntry: undefined, prompt: undefined },
            from: hook.definition,
            invoke: noInvoke,
            hooks: inbound,
            call,
          }),
      }
      const delivery = { ...write, hooks: inbound }
      const toolContext: ToolContext = {
        pending: run.pending,
        turn,
        stateFor: (tool: Loaded<FunctionTool>, entry: PromptToolConfig | undefined, callback: Callback): ThreadState =>
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
      let view = {
        side: turn.side,
        past: new Set<string>(),
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
                  { concurrency: 1, discard: true },
                ),
            }
          : undefined
      // Hooks section 5: the branch the tool's own outcome picks, then before_store_tool_result, then the stored
      // message, then tool_call_done with what was stored.
      const runCall = (
        callerSeq: number,
        call: ToolCall,
        outcome: Effect.Effect<ToolResult, never, Registry | Stores>,
      ) =>
        Effect.gen(function* () {
          const returned = run.stop !== undefined ? notRun : yield* outcome
          const skipped = returned === notRun
          const toolCall = hookCall(call, argumentsOf(call))
          const branched = skipped
            ? returned
            : yield* runHooks(
                hooks,
                returned.status === "success" ? "after_tool_call_success" : "after_tool_call_failure",
                [toolCall],
                returned,
              )
          const final = skipped ? returned : yield* runHooks(hooks, "before_store_tool_result", [toolCall], branched)
          const save = (result: ToolResult) =>
            Effect.try({
              try: () => storedResult(turn, call, result),
              catch: (cause) => new ResultUnreadable({ message: `reading it threw: ${describe(cause)}` }),
            }).pipe(
              Effect.flatMap((message) =>
                createMessage({ ...write, callerSeq }, message, skipped ? "skipped" : "result"),
              ),
            )
          // Runtime section 5.2: a failure between the tool's return and its stored result fails this one call.
          const { message: stored } = yield* save(final).pipe(
            Effect.catchTag(["ValueNotJson", "ResultUnreadable"], (error) =>
              save(unstorableResult(final, error.message)),
            ),
          )
          yield* record("persist-results", `${call.id} ${stored.tool_status}`)
          yield* observe({ type: "message", message: stored })
          // Hooks section 5.5: tool_call_done sees the result as the store holds it, after every hook and redaction.
          yield* runHooks(hooks, "tool_call_done", [toolCall], resultOf(stored))
          // Storing a result can turn a success into an error, and the stop tool outcome reports what was stored.
          return stored.tool_status == null ? final : { ...final, status: stored.tool_status }
        })
      // Threads section 3.1: a queued tool runs without a model response that asks for it. Spindle stores it as a
      // call of the prompt side with its result after it, so the next request shows both, and marks the call queued.
      const runQueuedTool = (entry: Queued & { readonly kind: "tool" }) =>
        Effect.gen(function* () {
          const definition = registry.definitions.find(
            (candidate) => candidate.kind === "tool" && candidate.qualifiedName === entry.toolName,
          )
          const value = definition === undefined ? undefined : registry.loaded.get(definition)
          const tool =
            definition !== undefined && isFunctionTool(value)
              ? ({ definition, value } as Loaded<FunctionTool>)
              : undefined
          const exposed = [...turn.tools.values()].find((candidate) => candidate.tool.definition === definition)
          const name = exposed?.name ?? definition?.name ?? entry.toolName
          const argumentsText = JSON.stringify(mapStrings(entry.args, redact, redact))
          const call: ToolCall = {
            id: `queued-${crypto.randomUUID()}`,
            name,
            arguments: { ...entry.args },
            argumentsText,
            problem: tool === undefined ? `The queued tool ${entry.toolName} is no longer defined` : undefined,
          }
          const { message, seq } = yield* createMessage(
            write,
            {
              role: roleOf(turn.side),
              content: null,
              tool_calls: JSON.stringify([
                { id: call.id, type: "function", function: { name, arguments: argumentsText } },
              ]),
              prompt: turn.prompt.definition.qualifiedName,
              status: "completed",
              metadata: { queued: true },
            },
            "queued",
            entry.seq,
          )
          yield* record("drain", `tool ${name} ${call.id}`)
          yield* observe({ type: "message", message })
          yield* runHooks(hooks, "tool_call_started", [hookCall(call, argumentsText)], undefined)
          yield* runCall(
            seq,
            call,
            tool === undefined
              ? Effect.succeed(failed(call.problem ?? ""))
              : executeTool(
                  tool,
                  entry.args,
                  (callback) => toolContext.stateFor(tool, exposed?.entry, callback),
                  run.pending,
                  scopeFor(turn, exposed?.entry),
                ),
          )
          return message.id
        })
      // Runtime section 3 step 1 and section 9: queued work enters in arrival order, one entry at a time, and each entry
      // leaves the queue in the transaction that stores what it delivers. The result says whether the prompt side got
      // something to act on: a queued tool, or a message from the other side's perspective.
      const drain = Effect.gen(function* () {
        let first: string | undefined
        let prompted = false
        let count = 0
        while (run.stop === undefined) {
          const entry = yield* runStore.nextQueued(threadId, { flowId })
          if (entry === undefined) break
          count += 1
          if (entry.kind === "tool") {
            const id = yield* runQueuedTool(entry)
            first ??= id
            prompted = true
            continue
          }
          const { message } = yield* createMessage(delivery, draftOf(entry.message), "turn", entry.seq)
          first ??= message.id
          yield* record("drain", `message ${message.id}`)
          yield* observe({ type: "message", message })
          if (message.role !== roleOf(turn.side)) prompted = true
        }
        if (count === 0) yield* record("drain", "none")
        return { prompted, first, count }
      })
      // Execution State section 3: a stop takes effect at the boundary between two operations. The run settles idle,
      // and the work still queued waits for the next trigger.
      const stopHere = Effect.suspend(() => {
        const reason = run.stop?.reason ?? "aborted"
        return record("stop", reason).pipe(
          Effect.andThen(release("idle", reason, false, CLOSING.aborted)),
          Effect.flatMap((settlement) => ended(settlement, "idle", reason)),
        )
      })
      let turnStart = true
      let turnSteps = 0
      while (true) {
        step += 1
        if (run.stop !== undefined) return yield* stopHere
        const { prompted, first, count } = yield* drain
        if (run.stop !== undefined) return yield* stopHere
        if (turnStart) {
          // Runtime section 3: with nothing for the prompt side to act on, the turn is the human's.
          if (!prompted) {
            yield* record("stop", "awaiting_human")
            const settlement = yield* release("idle", "awaiting_human", true, CLOSING.aborted)
            if (settlement === "continue") continue
            return yield* ended(settlement, "idle", "awaiting_human")
          }
          // The turn starts at the other side's latest message, and everything before it is past history.
          view = { ...view, past: pastOf((yield* history.read).messages, turn.side, count > 1 ? first : undefined) }
          turnStart = false
          turnSteps = 0
        }
        // Runtime section 4 orders the seven steps of an assembly.
        const rendered = yield* renderSystemPrompt(turn, secrets)
        yield* record("assemble", "interpolate the system prompt")
        const system = yield* runHooks(hooks, "after_system_message", [], rendered)
        yield* checkSystemPrompt(turn, system, secrets)
        yield* record("assemble", `after_system_message, ${countHooks(hooks, "after_system_message")} hooks`)
        // Runtime section 4: the snapshot is the persisted history at the moment filter_messages starts, whoever
        // wrote it. A message written later belongs to the next assembly. Nothing that could let a write in, such as
        // the trace, runs between the read and the first hook.
        const { messages: snapshot, positions } = yield* history.read
        const filtered = yield* runHooks(hooks, "filter_messages", [], snapshot)
        yield* record("assemble", `snapshot, ${snapshot.length} messages`)
        yield* record("assemble", `filter_messages, ${countHooks(hooks, "filter_messages")} hooks`)
        const transformed = toProviderMessages(filtered, view, positions)
        yield* record("assemble", `transform, ${transformed.length} provider messages`)
        const prefiltered = has(hooks, "prefilter_llm_history")
          ? (yield* runHooks(hooks, "prefilter_llm_history", [], transformed.map(toLLMMessage))).map(fromLLMMessage)
          : transformed
        // Messages section 1.3: a prompt that sets reasoning.include to false sends no reasoning, whatever a hook
        // put back.
        const messages = view.includeReasoning ? prefiltered : prefiltered.map(withoutReasoning)
        yield* checkSystemMessages(messages, secrets)
        yield* record("assemble", `prefilter_llm_history, ${countHooks(hooks, "prefilter_llm_history")} hooks`)
        if (run.stop !== undefined) return yield* stopHere
        yield* checkSystemPrompt(turn, system, secrets)
        const request = buildRequest(turn, system, messages, abort.signal)
        yield* record("assemble", `dispatch, ${request.messages.length} messages, ${request.tools?.length ?? 0} tools`)
        yield* observe({ type: "request", request })
        const response = yield* callModel(
          {
            step,
            provider,
            stopped: () => run.stop !== undefined,
            retries,
            toolChoice: prompt.toolChoice,
            calls: modelCalls,
            pending,
            record: (detail) => record("call", detail),
            ...(streamed === undefined ? {} : { streamed }),
          },
          request,
        )
        if (response === undefined) return yield* stopHere
        steps += 1
        run.steps = steps
        turnSteps += 1
        execution.stepCount += 1
        if (turn.side === "a") execution.sideAStepCount += 1
        else execution.sideBStepCount += 1
        const calls = toolCallsOf(response)
        const { message: assistant, seq } = yield* createMessage(write, responseMessage(turn, response, calls), "turn")
        yield* record("persist-response", `${assistant.id}, ${calls.length} tool calls`)
        yield* observe({ type: "message", message: assistant })
        if (calls.length === 0) {
          yield* record("tools", "none")
          yield* record("persist-results", "none")
        }
        const results: Array<ToolResult> = []
        for (const call of calls) {
          // A call after a stop request never runs. It still gets a result, so that the next request is valid.
          const skipped = run.stop !== undefined
          yield* record("tools", `${call.name} ${call.id}${skipped ? " not run" : ""}`)
          results.push(yield* runCall(seq, call, runToolCall(toolContext, call)))
        }
        if (run.stop !== undefined) return yield* stopHere
        // maxSteps counts the side's model steps in one turn, and the runtime cap counts every step of the execution.
        const reason = stopReason(
          {
            text: response.content,
            calls,
            sideSteps: turnSteps,
            totalSteps: execution.stepCount,
          },
          turn.config,
          stepCap,
        )
        yield* record("stop", reason ?? "continue")
        if (reason !== undefined) {
          const stopTool = reason === "stop_tool" ? stopToolOutcome(turn, calls, results, redact) : undefined
          // The runtime cap ends the execution even while the queue holds work, so that queued work cannot keep one
          // execution going without end.
          const settlement = yield* release("idle", reason, reason !== "max_total_steps", CLOSING.aborted)
          if (settlement === "continue") {
            turnStart = true
            continue
          }
          return yield* ended(settlement, "idle", reason, stopTool === undefined ? {} : { stopTool })
        }
      }
    })

    const fail = (reason: string, extra: { readonly error: RunError }) =>
      Effect.flatMap(release("failed", reason, false, CLOSING.failed), (settlement) =>
        ended(settlement, "failed", reason, extra),
      )

    return yield* loop.pipe(
      Effect.interruptible,
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        const found = Cause.findError(cause)
        if (found._tag === "Failure") return fail("fatal_error", { error: { message: describeCause(cause) } })
        const error = found.success
        switch (error._tag) {
          case "SetupError":
            return fail("fatal_error", { error: { message: error.message } })
          case "ProviderFailure":
            return fail("step_error", {
              error: {
                message: error.message,
                code: error.code,
                ...(error.statusCode === undefined ? {} : { statusCode: error.statusCode }),
                ...(error.retryAfter === undefined ? {} : { retryAfter: error.retryAfter }),
                ...(error.origin === undefined ? {} : { origin: error.origin }),
                ...(error.upstream === undefined ? {} : { upstream: error.upstream }),
              },
            })
          // Another process settled the run, as lost, or terminate did. The run writes nothing more and aborts what
          // it started.
          case "FlowEnded":
            return Effect.andThen(
              Effect.sync(() => abort.abort()),
              ended("superseded", "idle", "aborted"),
            )
          default:
            return fail("step_error", { error: { message: error.message } })
        }
      }),
      // An interrupt is an abort: the signal fires and the run settles idle. The first Ctrl-C of spindle run asked
      // for a stop, so its reason stays.
      Effect.onInterrupt(() =>
        Effect.andThen(
          Effect.promise(async () => {
            abort.abort()
            if (run.waitForCallbacks && run.pending.size && !run.releaseWait.signal.aborted) {
              await Promise.race([
                Promise.allSettled(run.pending.keys()),
                new Promise<void>((resolve) =>
                  run.releaseWait.signal.addEventListener("abort", () => resolve(), { once: true }),
                ),
              ])
            }
          }),
          Effect.orDie(
            Effect.tap(release("idle", run.stop?.reason ?? "aborted", false, CLOSING.aborted), (settlement) =>
              Effect.gen(function* () {
                if (settlement === "superseded")
                  run.displaced = (yield* threadStore.getThread(threadId)).terminated === null
                run.resumeQueued = settlement === "settled" && run.waitForCallbacks === true
              }),
            ),
          ),
        ),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          run.ended = true
        }),
      ),
    )
  })
