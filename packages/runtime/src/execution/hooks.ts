import type {
  AgentDefinition,
  HookExecutionSource,
  HookToolCall,
  Message,
  ThreadState,
  ToolResult,
} from "@standardagents/spec"
import { Clock, Context, Data, Duration, Effect, Predicate, Schema } from "effect"
import type { Definition } from "../registry/Registry.ts"
import { parseJson, toJson } from "../store/json.ts"
import { isAttachmentRef } from "../store/schema.ts"
import { Callback } from "./callback.ts"
import type { Execution } from "./Execution.ts"
import { isRequestHistory, type RequestMessage } from "./llm-history.ts"
import { isToolResult, readResult } from "./tools.ts"
import { type Loaded, lookup, SetupError, type Turn } from "./turn.ts"

// Hooks section 1.2 asks for a timeout and names none. One setting covers every hook call.
export const HookTimeout = Context.Reference<Duration.Duration>("spindle/HookTimeout", {
  defaultValue: () => Duration.seconds(30),
})

// A hook that writes a message runs the create hooks again, and those may write too. One setting bounds how deep a
// chain of such writes may go.
export const NestedWriteLimit = Context.Reference<number>("spindle/NestedWriteLimit", { defaultValue: () => 8 })

interface ObserverArgs {
  after_thread_created: []
  after_create_message: [Message]
  after_update_message: [Message]
  tool_call_started: [HookToolCall, string | undefined]
  tool_call_done: [HookToolCall, ToolResult]
}

interface Values {
  after_system_message: string
  filter_messages: ReadonlyArray<Message>
  prefilter_llm_history: Array<RequestMessage>
  before_create_message: Message
  before_update_message: Record<string, unknown>
  before_store_tool_result: ToolResult
  after_tool_call_success: ToolResult
  after_tool_call_failure: ToolResult
}

type Veto = "before_create_message" | "before_update_message"
type Position = keyof Values | keyof ObserverArgs
type Prefix<K> = K extends "before_update_message"
  ? [string]
  : K extends "after_tool_call_success" | "after_tool_call_failure" | "before_store_tool_result"
    ? [HookToolCall]
    : []

const INVALID = Symbol("invalid")

interface Transform<V> {
  readonly where: string
  readonly accept: (returned: unknown, current: V) => V | typeof INVALID
  readonly expects: string
  readonly kept: string
}

// A hook's return is user data. Reading it once into plain JSON data runs every getter here, so a getter that throws
// fails that hook, no later read can throw, and the store can hold what is left.
const plain = (value: unknown): unknown => {
  const text = toJson(value)
  return typeof text === "string" ? JSON.parse(text) : INVALID
}

// Hooks section 8.6 writes metadata as JSON text, and Messages section 1 types it as an object, so a string that
// holds a JSON object is read as that object.
const metadataOf = (value: unknown): Record<string, unknown> | undefined | typeof INVALID => {
  if (value === undefined || Predicate.isObject(value)) return value
  if (typeof value !== "string") return INVALID
  const parsed = parseJson(value)
  return Predicate.isObject(parsed) ? parsed : INVALID
}

// The text fields of a stored message, which a hook may set and Spindle redacts when a hook changes them.
export const TEXT_FIELDS = [
  "content",
  "name",
  "tool_calls",
  "tool_call_id",
  "reasoning_content",
  "reasoning_details",
  "prompt",
  "parent_id",
] as const

const isText = (value: unknown) => value === undefined || value === null || typeof value === "string"
const oneOf = (value: unknown, allowed: ReadonlyArray<unknown>) => value === undefined || allowed.includes(value)
const optional = (value: unknown, test: (value: unknown) => boolean) => value === undefined || test(value)
const isCount = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
const isString = (value: unknown) => typeof value === "string"
// An id is a key that the store, a log line, and every reader hold as it is. Node's SQLite driver ends a string at a
// NUL character, and UTF-8 has no encoding for a lone surrogate.
const isSafeId = (id: string) => id !== "" && [...id].length <= 255 && !/[\p{Cc}\uD800-\uDFFF]/u.test(id)

// Messages section 1, as the package's Message type gives it. A hook may leave out a field that type makes optional.
const isMessage = (value: unknown): value is Message =>
  Predicate.isObject(value) &&
  isString(value.id) &&
  isCount(value.created_at) &&
  (value.role === "system" || value.role === "user" || value.role === "assistant" || value.role === "tool") &&
  (value.content === null || isString(value.content)) &&
  TEXT_FIELDS.every((field) => isText(value[field])) &&
  oneOf(value.tool_status, ["success", "error", null]) &&
  oneOf(value.status, ["pending", "completed", "failed", null]) &&
  optional(value.depth, isCount) &&
  optional(value.silent, (silent) => typeof silent === "boolean") &&
  optional(value.attachments, (list) => list === null || (Array.isArray(list) && list.every(isAttachmentRef))) &&
  optional(value.metadata, Predicate.isObject)

// The returned message is stored as it is, so every field it sets must be one the store can hold. A hook may not
// change which message a record is, so the role, the tool calls, and a tool result's call id stay as the hook was
// given them. The loop runs the calls the model returned, and each result must answer a call that the record lists.
const acceptMessage = (returned: unknown, current: Message): Message | typeof INVALID => {
  const value = plain(returned)
  if (!Predicate.isObject(value)) return INVALID
  const metadata = metadataOf(value.metadata)
  if (metadata === INVALID) return INVALID
  const message = { ...value, metadata }
  return isMessage(message) &&
    isSafeId(message.id) &&
    message.role === current.role &&
    (message.tool_calls ?? null) === current.tool_calls &&
    (current.role !== "tool" || message.tool_call_id === current.tool_call_id)
    ? message
    : INVALID
}

// The array a request hook returns shapes one request and is never stored, so a structured clone, which is cheaper
// than a round trip through JSON on a long history, is enough to run each getter once.
const acceptMessages = (returned: unknown) => {
  const value: unknown = structuredClone(returned)
  return Array.isArray(value) && value.every(isMessage) ? value : INVALID
}

// MessageUpdates holds content and metadata. A key the hook adds or changes beyond those has nowhere to go, so the
// return is refused rather than stored in part. A key the caller passed and the hook kept is the caller's.
const acceptUpdate = (returned: unknown, current: Record<string, unknown>) => {
  const value = plain(returned)
  if (!Predicate.isObject(value)) return INVALID
  const metadata = metadataOf(value.metadata)
  if (metadata === INVALID) return INVALID
  const patch = { ...value, ...(metadata === undefined ? {} : { metadata }) }
  for (const [key, value] of Object.entries(patch)) {
    if (key === "content" && (value === undefined || typeof value === "string")) continue
    if (key === "metadata") continue
    if (Object.hasOwn(current, key) && current[key] === value) continue
    return INVALID
  }
  return patch
}

const isNewFile = Schema.is(
  Schema.Struct({
    name: Schema.String,
    mimeType: Schema.String,
    data: Schema.String,
    width: Schema.optional(Schema.Natural),
    height: Schema.optional(Schema.Natural),
  }),
)

const acceptResult = (returned: unknown) => {
  const result = readResult(returned)
  if (result === undefined) return INVALID
  const value = plain(result)
  return isToolResult(value) &&
    (value.attachments === undefined || value.attachments.every((item) => isAttachmentRef(item) || isNewFile(item)))
    ? value
    : INVALID
}

const branch = (where: string): Transform<ToolResult> => ({
  where,
  accept: (returned, current) => (returned === null ? current : acceptResult(returned)),
  expects: "a ToolResult or null",
  kept: "kept the result the hook was given",
})

const observers: Record<keyof ObserverArgs, string> = {
  after_thread_created: "after a thread is created, before any message",
  after_create_message: "after a message is stored",
  after_update_message: "after a message is updated",
  tool_call_started: "when a tool call starts in the model's stream",
  tool_call_done: "after a tool call's result is stored",
}

const transforms: { [K in keyof Values]: Transform<Values[K]> } = {
  after_system_message: {
    where: "after the system prompt is interpolated, before the history snapshot",
    accept: (returned, current) =>
      returned === null || returned === undefined ? current : typeof returned === "string" ? returned : INVALID,
    expects: "a string, null, or undefined",
    kept: "kept the system message the hook was given",
  },
  filter_messages: {
    where: "once per context assembly, on the history snapshot",
    accept: acceptMessages,
    expects: "an array of messages",
    kept: "kept the history the hook was given",
  },
  prefilter_llm_history: {
    where: "after the history becomes provider messages, before the request",
    accept: (returned) => {
      const value: unknown = structuredClone(returned)
      return isRequestHistory(value) ? value : INVALID
    },
    expects: "an array of messages that provider messages can hold",
    kept: "kept the provider messages the hook was given",
  },
  before_create_message: {
    where: "before a message is stored",
    accept: acceptMessage,
    expects: "a message the store can hold, with the role, the tool calls, and the call id it was given",
    kept: "kept the message the hook was given",
  },
  before_update_message: {
    where: "before a message is updated",
    accept: acceptUpdate,
    expects: "updates that change only content and metadata",
    kept: "kept the updates the hook was given",
  },
  before_store_tool_result: {
    where: "before a tool result is stored",
    accept: acceptResult,
    expects: "a ToolResult",
    kept: "kept the result the hook was given",
  },
  after_tool_call_success: branch("after a tool call succeeds, before its result is stored"),
  after_tool_call_failure: branch("after a tool call fails, before its result is stored"),
}

interface SelectedHook {
  readonly id: string
  readonly definition: Definition
  readonly execute: (...args: ReadonlyArray<unknown>) => unknown
}

export interface HookSet {
  readonly source: HookExecutionSource
  readonly byPosition: ReadonlyMap<string, ReadonlyArray<SelectedHook>>
}

// One call of one hook. Its ThreadState refuses every call once the call runs past the hook time limit. A write that
// the loop, a tool, or a caller at rest makes has depth 0, and a hook called for a write of depth d has depth d + 1,
// which its own writes carry.
export interface HookCall extends Callback {
  readonly hook: string
  readonly position: Position
  readonly depth: number
}

export interface HookScope {
  readonly execution?: Execution
  readonly set: HookSet
  readonly stateFor: (hook: SelectedHook, call: HookCall) => ThreadState
}

export const countHooks = (scope: HookScope, position: Position) => scope.set.byPosition.get(position)?.length ?? 0

const isHook = (value: unknown): value is { hook: string; id: string; execute: SelectedHook["execute"] } =>
  Predicate.isObject(value) &&
  typeof value.hook === "string" &&
  typeof value.id === "string" &&
  typeof value.execute === "function"

// Hooks section 1.3: one list is the whole set. Each id runs once, in the order the list first names it.
const selectHooks = Effect.fn("selectHooks")(function* (
  ids: ReadonlyArray<string>,
  from: Definition,
  source: HookExecutionSource,
) {
  const byPosition = new Map<string, Array<SelectedHook>>()
  const seen = new Set<Definition>()
  for (const id of ids) {
    const found = yield* lookup<unknown>("hook", id, from)
    if (found === undefined || !isHook(found.value))
      return yield* new SetupError({ message: `${from.qualifiedName} names hook ${id}, which is not a defined hook` })
    if (seen.has(found.definition)) continue
    seen.add(found.definition)
    byPosition.set(found.value.hook, [
      ...(byPosition.get(found.value.hook) ?? []),
      { id: found.value.id, definition: found.definition, execute: found.value.execute },
    ])
  }
  return { source, byPosition } satisfies HookSet
})

// Prompts section 8: a non-empty prompt list is the whole set, whatever types it holds. Otherwise the agent's list is.
export const turnHooks = (turn: Turn) => {
  const listed = turn.prompt.value.hooks ?? []
  return listed.length > 0
    ? selectHooks(listed, turn.prompt.definition, { kind: "prompt", promptName: turn.prompt.definition.qualifiedName })
    : agentHooks(turn.agent)
}

// Hooks section 1.3: an operation at rest has no active prompt and uses the agent's list.
export const agentHooks = (agent: Loaded<AgentDefinition>) =>
  selectHooks(agent.value.hooks ?? [], agent.definition, { kind: "agent", agentName: agent.definition.qualifiedName })

export class HookExpired extends Data.TaggedError("HookExpired")<{
  readonly hook: string
  readonly position: Position
}> {
  override get message() {
    return `Hook ${this.hook} (${this.position}) ran past its time limit, so Spindle refused this call from its ThreadState`
  }
}

export class NestedWriteTooDeep extends Data.TaggedError("NestedWriteTooDeep")<{
  readonly hook: string
  readonly position: Position
  readonly depth: number
  readonly limit: number
}> {
  override get message() {
    return `Hook ${this.hook} (${this.position}) made a write ${this.depth} hook writes deep, past the limit of ${this.limit}, so Spindle refused it`
  }
}

export class HookFailed extends Data.TaggedError("HookFailed")<{
  readonly hook: string
  readonly position: Position
  readonly problem: string
}> {
  override get message() {
    return `Hook ${this.hook} (${this.position}) ${this.problem}, so Spindle did not make the change`
  }
}

// A hook may block the thread past its deadline before the timer gets a turn.
const invoke = Effect.fnUntraced(function* (
  scope: HookScope,
  hook: SelectedHook,
  call: HookCall,
  args: () => readonly unknown[],
  timeout: Duration.Duration,
) {
  const execute = () => hook.execute(scope.stateFor(hook, call), ...args(), { source: { ...scope.set.source } })
  const started = yield* Clock.currentTimeMillis
  const result = yield* Effect.tryPromise({
    try: () => (scope.execution ? scope.execution.call(call, `hook ${hook.id}`, execute) : call.invoke(execute)),
    catch: () => "threw an error",
  }).pipe(Effect.timeoutOption(timeout), Effect.result)
  if (
    (result._tag === "Success" && result.success._tag === "None") ||
    (yield* Clock.currentTimeMillis) - started > Duration.toMillis(timeout)
  )
    call.expire()
  if (!call.expired) {
    if (result._tag === "Failure") return { problem: result.failure } as const
    if (result.success._tag === "Some") return { value: result.success.value } as const
  }
  return { problem: `did not settle within ${Duration.format(timeout)}` } as const
})

interface HookOptions<V> {
  copyInitial?: (value: V) => V
  depth?: number
  check?: (next: V, current: V, hook: string) => Effect.Effect<string | undefined>
}

function accept<V>(row: Transform<V>, returned: unknown, current: V): V | typeof INVALID {
  try {
    return row.accept(returned, current)
  } catch {
    return INVALID
  }
}

const pipeline = <V, E = never>(
  scope: HookScope,
  position: Position,
  contract: string | Transform<V>,
  prefix: readonly unknown[],
  initial: V,
  options: HookOptions<V>,
  refuse?: (error: HookFailed) => Effect.Effect<never, E>,
) =>
  Effect.gen(function* () {
    const hooks = scope.set.byPosition.get(position)
    if (!hooks) return initial
    const timeout = yield* HookTimeout
    const transform = typeof contract === "string" ? undefined : contract
    let current = initial
    for (const hook of hooks) {
      const call = Object.assign(new Callback(), { hook: hook.id, position, depth: (options.depth ?? 0) + 1 })
      const returned = yield* invoke(
        scope,
        hook,
        call,
        () => {
          const args = prefix.map((arg) => structuredClone(arg))
          if (transform)
            args.push(
              current === initial && options.copyInitial ? options.copyInitial(initial) : structuredClone(current),
            )
          return args
        },
        timeout,
      )
      let problem = returned.problem
      if (problem === undefined) {
        if (!transform) continue
        const next = accept(transform, returned.value, current)
        if (next === INVALID) problem = `returned a value that is not ${transform.expects}`
        else {
          problem = options.check ? yield* options.check(next, current, hook.id) : undefined
          if (problem === undefined) {
            current = next
            continue
          }
        }
      }
      const late = call.expired
        ? " Its ThreadState refuses every later call, and Spindle cannot undo what it does after this point by other means."
        : ""
      const where = typeof contract === "string" ? contract : contract.where
      const action = refuse ? "refused the change" : (transform?.kept ?? "went on")
      yield* Effect.logWarning(`Hook ${hook.id} (${position}, ${where}) ${problem}. Spindle ${action}.${late}`)
      if (refuse) return yield* refuse(new HookFailed({ hook: hook.id, position, problem }))
    }
    return current
  })

export const observeHooks = <K extends keyof ObserverArgs>(
  scope: HookScope,
  position: K,
  args: ObserverArgs[K],
  options: Pick<HookOptions<void>, "depth"> = {},
) => pipeline(scope, position, observers[position], args, undefined, options)

export const transformHooks = <K extends Exclude<keyof Values, "before_update_message">>(
  scope: HookScope,
  position: K,
  prefix: Prefix<K>,
  value: Values[K],
  options: HookOptions<Values[K]> = {},
) => pipeline(scope, position, transforms[position], prefix, value, options)

export const vetoHooks = <K extends Veto>(
  scope: HookScope,
  position: K,
  prefix: Prefix<K>,
  value: Values[K],
  options: HookOptions<Values[K]> = {},
) => pipeline(scope, position, transforms[position], prefix, value, options, Effect.fail)
