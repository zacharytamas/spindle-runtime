import type {
  AgentDefinition,
  HookExecutionSource,
  LLMMessage,
  Message,
  ThreadState,
  ToolResult,
} from "@standardagents/spec"
import { Clock, Context, Data, Duration, Effect } from "effect"
import type { Definition } from "../registry/Registry.ts"
import { toJson } from "../store/json.ts"
import { isAttachmentRef } from "../store/schema.ts"
import { type Callback, invokeCallback, type PendingCallbacks } from "./callback.ts"
import { readResult } from "./tools.ts"
import { type Loaded, lookup, SetupError, type Turn } from "./turn.ts"

// Hooks section 1.2 asks for a timeout and names none. One setting covers every hook call.
export const HookTimeout = Context.Reference<Duration.Duration>("spindle/HookTimeout", {
  defaultValue: () => Duration.seconds(30),
})

// A hook that writes a message runs the create hooks again, and those may write too. One setting bounds how deep a
// chain of such writes may go.
export const NestedWriteLimit = Context.Reference<number>("spindle/NestedWriteLimit", { defaultValue: () => 8 })

// The value each position hands its hooks in turn. A transforming hook replaces it, an observing hook only sees it.
export interface Values {
  readonly after_thread_created: undefined
  readonly after_system_message: string
  readonly filter_messages: ReadonlyArray<Message>
  readonly prefilter_llm_history: Array<LLMMessage>
  readonly before_create_message: Message
  readonly after_create_message: Message
  readonly before_update_message: Record<string, unknown>
  readonly after_update_message: Message
  readonly before_store_tool_result: ToolResult
  readonly after_tool_call_success: ToolResult
  readonly after_tool_call_failure: ToolResult
  readonly tool_call_started: string | undefined
  readonly tool_call_done: ToolResult
}

export type Position = keyof Values

type Vetoes = "before_create_message" | "before_update_message"

const INVALID = Symbol("invalid")

interface Row<V> {
  readonly where: string
  // The next value, or INVALID when the hook returned something this position cannot take.
  readonly accept: (returned: unknown, current: V) => V | typeof INVALID
  readonly expects: string
  // keep: the next hook and the loop get the value the failed hook was given. veto: a write its caller may refuse
  // does not happen. A write the execution cannot go on without keeps the value instead.
  readonly failure: "keep" | "veto"
  readonly kept: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const ROLES: ReadonlyArray<unknown> = ["system", "user", "assistant", "tool"]

// A hook's return is user data. Reading it once into plain JSON data runs every getter here, so a getter that throws
// fails that hook, no later read can throw, and the store can hold what is left.
const plain = (value: unknown): unknown => {
  const text = toJson(value)
  return typeof text === "string" ? JSON.parse(text) : INVALID
}

const observe = <V>(where: string): Row<V> => ({
  where,
  accept: (_returned, current) => current,
  expects: "anything",
  failure: "keep",
  kept: "went on",
})

// Hooks section 8.6 writes metadata as JSON text, and Messages section 1 types it as an object, so a string that
// holds a JSON object is read as that object.
const metadataOf = (value: unknown): Record<string, unknown> | undefined | typeof INVALID => {
  if (value === undefined || isRecord(value)) return value
  if (typeof value !== "string") return INVALID
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : INVALID
  } catch {
    return INVALID
  }
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
  isRecord(value) &&
  isString(value.id) &&
  isCount(value.created_at) &&
  ROLES.includes(value.role) &&
  (value.content === null || isString(value.content)) &&
  TEXT_FIELDS.every((field) => isText(value[field])) &&
  oneOf(value.tool_status, ["success", "error", null]) &&
  oneOf(value.status, ["pending", "completed", "failed", null]) &&
  optional(value.depth, isCount) &&
  optional(value.silent, (silent) => typeof silent === "boolean") &&
  optional(value.attachments, (list) => list === null || (Array.isArray(list) && list.every(isAttachmentRef))) &&
  optional(value.metadata, isRecord)

// The returned message is stored as it is, so every field it sets must be one the store can hold. A hook may not
// change which message a record is, so the role, the tool calls, and a tool result's call id stay as the hook was
// given them. The loop runs the calls the model returned, and each result must answer a call that the record lists.
const acceptMessage = (returned: unknown, current: Message): Message | typeof INVALID => {
  const value = plain(returned)
  if (!isRecord(value)) return INVALID
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

const parses = (text: string) => {
  try {
    return isRecord(JSON.parse(text))
  } catch {
    return false
  }
}

const DETAIL = ["auto", "low", "high"]

// The ContentPart union of the package's provider types.
const isContentPart = (value: unknown) => {
  if (!isRecord(value)) return false
  switch (value.type) {
    case "text":
      return isString(value.text)
    case "image":
      return isString(value.data) && isString(value.mediaType) && oneOf(value.detail, DETAIL)
    case "image_url":
      return isRecord(value.image_url) && isString(value.image_url.url) && oneOf(value.image_url.detail, DETAIL)
    case "file":
      return isString(value.data) && isString(value.mediaType) && optional(value.filename, isString)
    default:
      return false
  }
}

// Array.prototype.every skips a hole in an array, and the request conversion reads a hole as undefined.
const isListOf = (value: unknown, test: (item: unknown) => boolean) =>
  Array.isArray(value) && Array.from(value).every(test)

const isParts = (value: unknown) => isListOf(value, isContentPart)

const isCall = (value: unknown) =>
  isRecord(value) &&
  isString(value.id) &&
  isRecord(value.function) &&
  isString(value.function.name) &&
  ((isRecord(value.function.arguments) && isString(toJson(value.function.arguments))) ||
    (isString(value.function.arguments) && parses(value.function.arguments))) &&
  optional(value.extra_content, (extra) => isRecord(extra) && isString(toJson(extra)))

const DETAIL_TYPES: ReadonlyArray<unknown> = ["text", "summary", "encrypted"]

// The ProviderReasoningDetail type of the package, the shape every provider reads a detail in.
const isReasoningDetail = (value: unknown) =>
  isRecord(value) &&
  DETAIL_TYPES.includes(value.type) &&
  optional(value.id, isString) &&
  optional(value.text, isString) &&
  optional(value.data, isString) &&
  optional(value.format, isString)

// Hooks section 3.3 makes the returned array the provider request history, so each message must be one that a
// provider message type of the package holds as it is. Only a user or a tool message may hold content parts.
const isLLMMessage = (value: unknown) => {
  if (!isRecord(value)) return false
  switch (value.role) {
    case "system":
      return isString(value.content)
    case "user":
      return isString(value.content) || isParts(value.content)
    case "assistant":
      return (
        optional(value.content, (content) => content === null || isString(content)) &&
        optional(value.tool_calls, (calls) => isListOf(calls, isCall)) &&
        optional(value.reasoning_content, isString) &&
        optional(value.reasoning_details, (details) => isListOf(details, isReasoningDetail))
      )
    case "tool":
      return (
        isString(value.tool_call_id) &&
        optional(value.name, isString) &&
        oneOf(value.tool_status, ["success", "error"]) &&
        (isString(value.content) || (value.tool_status !== "error" && isParts(value.content)))
      )
    default:
      return false
  }
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
  if (!isRecord(value)) return INVALID
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

const isNewFile = (value: unknown) =>
  isRecord(value) &&
  isString(value.name) &&
  isString(value.mimeType) &&
  isString(value.data) &&
  optional(value.width, isCount) &&
  optional(value.height, isCount)

// Hooks section 6.3: each attachment is a new file or a reference to a stored one.
const acceptResult = (returned: unknown) => {
  const result = readResult(returned)
  const value = result === undefined ? INVALID : plain(result)
  return isRecord(value) &&
    optional(
      value.attachments,
      (list) => Array.isArray(list) && list.every((item) => isAttachmentRef(item) || isNewFile(item)),
    )
    ? (value as unknown as ToolResult)
    : INVALID
}

const branch = (where: string): Row<ToolResult> => ({
  where,
  accept: (returned, current) => (returned === null ? current : acceptResult(returned)),
  expects: "a ToolResult or null",
  failure: "keep",
  kept: "kept the result the hook was given",
})

// Runtime section 4, Hooks sections 3 to 5, and Messages section 3. The loop calls each position at the place
// that where names, and reads accept and failure from here. No other code decides what a hook's return means.
export const POSITIONS: { readonly [K in Position]: Row<Values[K]> } = {
  after_thread_created: observe("after a thread is created, before any message"),
  after_system_message: {
    where: "after the system prompt is interpolated, before the history snapshot",
    accept: (returned, current) =>
      returned === null || returned === undefined ? current : typeof returned === "string" ? returned : INVALID,
    expects: "a string, null, or undefined",
    failure: "keep",
    kept: "kept the system message the hook was given",
  },
  filter_messages: {
    where: "once per context assembly, on the history snapshot",
    accept: acceptMessages,
    expects: "an array of messages",
    failure: "keep",
    kept: "kept the history the hook was given",
  },
  prefilter_llm_history: {
    where: "after the history becomes provider messages, before the request",
    accept: (returned) => {
      const value: unknown = structuredClone(returned)
      return isListOf(value, isLLMMessage) ? (value as Array<LLMMessage>) : INVALID
    },
    expects: "an array of messages that provider messages can hold",
    failure: "keep",
    kept: "kept the provider messages the hook was given",
  },
  before_create_message: {
    where: "before a message is stored",
    accept: acceptMessage,
    expects: "a message the store can hold, with the role, the tool calls, and the call id it was given",
    failure: "veto",
    kept: "kept the message the hook was given",
  },
  after_create_message: observe("after a message is stored"),
  before_update_message: {
    where: "before a message is updated",
    accept: acceptUpdate,
    expects: "updates that change only content and metadata",
    failure: "veto",
    kept: "kept the updates the hook was given",
  },
  after_update_message: observe("after a message is updated"),
  before_store_tool_result: {
    where: "before a tool result is stored",
    accept: acceptResult,
    expects: "a ToolResult",
    failure: "keep",
    kept: "kept the result the hook was given",
  },
  after_tool_call_success: branch("after a tool call succeeds, before its result is stored"),
  after_tool_call_failure: branch("after a tool call fails, before its result is stored"),
  tool_call_started: observe("when a tool call starts in the model's stream"),
  tool_call_done: observe("after a tool call's result is stored"),
}

export interface SelectedHook {
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
  expired: boolean
}

export interface HookScope {
  readonly pending?: PendingCallbacks
  readonly set: HookSet
  readonly stateFor: (hook: SelectedHook, call: HookCall) => ThreadState
}

export const has = (scope: HookScope, position: Position) => scope.set.byPosition.has(position)

export const countHooks = (scope: HookScope, position: Position) => scope.set.byPosition.get(position)?.length ?? 0

const isHook = (value: unknown): value is { hook: string; id: string; execute: SelectedHook["execute"] } =>
  isRecord(value) &&
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

const callHook = (
  hook: SelectedHook,
  args: () => ReadonlyArray<unknown>,
  timeout: Duration.Duration,
  call: HookCall,
  pending: HookScope["pending"],
) =>
  Effect.tryPromise({
    try: () => invokeCallback(call, pending, `hook ${hook.id}`, () => hook.execute(...args())),
    catch: () => "threw an error",
  }).pipe(Effect.timeoutOption(timeout), Effect.result)

// Hooks section 1.2: a hook's failure is logged with its id and type only. The thrown error and the hook's
// arguments can hold message content or a secret, so neither reaches the log.
export const runHooks = <K extends Position>(
  scope: HookScope,
  position: K,
  lead: ReadonlyArray<unknown>,
  value: Values[K],
  options: {
    readonly essential?: boolean
    // The depth of the write these hooks decorate. Anything else they decorate has depth 0.
    readonly depth?: number
    // A check the return passes only against stored state, such as an id that no message holds yet. It gives the
    // problem, or undefined when there is none.
    readonly check?: (next: Values[K], current: Values[K], hook: string) => Effect.Effect<string | undefined>
  } = {},
): Effect.Effect<Values[K], K extends Vetoes ? HookFailed : never> =>
  Effect.gen(function* () {
    const hooks = scope.set.byPosition.get(position)
    if (hooks === undefined) return value
    const row = POSITIONS[position] as Row<Values[K]>
    const timeout = yield* HookTimeout
    const check = options.check ?? (() => Effect.undefined)
    let current = value
    for (const hook of hooks) {
      const call: HookCall = { hook: hook.id, position, depth: (options.depth ?? 0) + 1, expired: false }
      const args = () => [
        scope.stateFor(hook, call),
        ...lead.map((arg) => structuredClone(arg)),
        ...(position === "after_thread_created" ? [] : [structuredClone(current)]),
        { source: { ...scope.set.source } },
      ]
      const started = yield* Clock.currentTimeMillis
      const outcome = yield* callHook(hook, args, timeout, call, scope.pending)
      // A hook that blocks the thread can return before the timer that bounds it fires, so the time it took decides.
      call.expired =
        (outcome._tag === "Success" && outcome.success._tag === "None") ||
        (yield* Clock.currentTimeMillis) - started > Duration.toMillis(timeout)
      if (call.expired && call.promise) scope.pending?.forget(call.promise)
      let problem: string
      let late = ""
      if (call.expired || outcome._tag === "Failure" || outcome.success._tag === "None") {
        problem =
          call.expired || outcome._tag === "Success"
            ? `did not settle within ${Duration.format(timeout)}`
            : outcome.failure
        if (call.expired)
          late =
            " Its ThreadState refuses every later call, and Spindle cannot undo what it does after this point by other means."
      } else {
        let next: Values[K] | typeof INVALID
        try {
          next = row.accept(outcome.success.value, current)
        } catch {
          next = INVALID
        }
        const found =
          next === INVALID ? `returned a value that is not ${row.expects}` : yield* check(next, current, hook.id)
        if (found === undefined) {
          current = next as Values[K]
          continue
        }
        problem = found
      }
      const veto = row.failure === "veto" && options.essential !== true
      yield* Effect.logWarning(
        `Hook ${hook.id} (${position}, ${row.where}) ${problem}. Spindle ${veto ? "refused the change" : row.kept}.${late}`,
      )
      if (veto) return yield* new HookFailed({ hook: hook.id, position, problem })
    }
    return current
  }) as Effect.Effect<Values[K], K extends Vetoes ? HookFailed : never>
