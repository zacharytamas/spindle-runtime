import type {
  AgentDefinition,
  HookExecutionSource,
  LLMMessage,
  Message,
  ThreadState,
  ToolResult,
} from "@standardagents/spec"
import { Context, Data, Duration, Effect } from "effect"
import type { Definition } from "../registry/Registry.ts"
import { readResult } from "./tools.ts"
import { type Loaded, lookup, SetupError, type Turn } from "./turn.ts"

// Hooks section 1.2 asks for a timeout and names none. One setting covers every hook call.
export const HookTimeout = Context.Reference<Duration.Duration>("spindle/HookTimeout", {
  defaultValue: () => Duration.seconds(30),
})

// The value each position hands its hooks in turn. A transforming hook replaces it, an observing hook only sees it.
export interface Values {
  readonly after_thread_created: undefined
  readonly after_system_message: string
  readonly filter_messages: Array<Message>
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

const hasRole = (value: unknown) => isRecord(value) && ROLES.includes(value.role)

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
const loneSurrogate = /[\uD800-\uDFFF]/u

// The returned message is stored as it is, so every field it sets must be one the store can hold.
const acceptMessage = (returned: unknown): Message | typeof INVALID => {
  if (!isRecord(returned)) return INVALID
  const metadata = metadataOf(returned.metadata)
  const { id, created_at, depth } = returned
  if (
    metadata === INVALID ||
    typeof id !== "string" ||
    id === "" ||
    loneSurrogate.test(id) ||
    typeof created_at !== "number" ||
    !Number.isSafeInteger(created_at) ||
    created_at < 0 ||
    !ROLES.includes(returned.role) ||
    !TEXT_FIELDS.every((field) => isText(returned[field])) ||
    !oneOf(returned.tool_status, ["success", "error", null]) ||
    !oneOf(returned.status, ["pending", "completed", "failed", null]) ||
    !(depth === undefined || (typeof depth === "number" && Number.isSafeInteger(depth) && depth >= 0)) ||
    !(returned.silent === undefined || typeof returned.silent === "boolean") ||
    !(returned.attachments === undefined || returned.attachments === null || Array.isArray(returned.attachments))
  )
    return INVALID
  return { ...returned, metadata } as unknown as Message
}

// MessageUpdates holds content and metadata. A key the hook adds or changes beyond those has nowhere to go, so the
// return is refused rather than stored in part. A key the caller passed and the hook kept is the caller's.
const acceptUpdate = (returned: unknown, current: Record<string, unknown>) => {
  if (!isRecord(returned)) return INVALID
  const metadata = metadataOf(returned.metadata)
  if (metadata === INVALID) return INVALID
  const patch = { ...returned, ...(metadata === undefined ? {} : { metadata }) }
  for (const [key, value] of Object.entries(patch)) {
    if (key === "content" && (value === undefined || typeof value === "string")) continue
    if (key === "metadata") continue
    if (Object.hasOwn(current, key) && current[key] === value) continue
    return INVALID
  }
  return patch
}

const acceptResult = (returned: unknown) => readResult(returned) ?? INVALID

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
    accept: (returned) => (Array.isArray(returned) && returned.every(hasRole) ? (returned as Array<Message>) : INVALID),
    expects: "an array of messages",
    failure: "keep",
    kept: "kept the history the hook was given",
  },
  prefilter_llm_history: {
    where: "after the history becomes provider messages, before the request",
    accept: (returned) =>
      Array.isArray(returned) && returned.every(hasRole) ? (returned as Array<LLMMessage>) : INVALID,
    expects: "an array of messages with the role system, user, assistant, or tool",
    failure: "keep",
    kept: "kept the provider messages the hook was given",
  },
  before_create_message: {
    where: "before a message is stored",
    accept: acceptMessage,
    expects: "a message the store can hold",
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

export interface HookScope {
  readonly set: HookSet
  readonly stateFor: (hook: SelectedHook) => ThreadState
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

export const hookScope = (set: HookSet, makeState: (hook: SelectedHook) => ThreadState): HookScope => {
  const states = new Map<Definition, ThreadState>()
  return {
    set,
    stateFor: (hook) => {
      const known = states.get(hook.definition)
      if (known !== undefined) return known
      const state = makeState(hook)
      states.set(hook.definition, state)
      return state
    },
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

// A hook may change what it is given in place, so each call gets its own copy, and a failed call leaves nothing.
const copy = <A>(value: A): A => {
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

const callHook = (hook: SelectedHook, args: ReadonlyArray<unknown>, timeout: Duration.Duration) =>
  Effect.tryPromise({
    try: () => Promise.resolve(hook.execute(...args)),
    catch: () => "threw an error",
  }).pipe(Effect.timeoutOption(timeout), Effect.result)

// Hooks section 1.2: a hook's failure is logged with its id and type only. The thrown error and the hook's
// arguments can hold message content or a secret, so neither reaches the log.
export const runHooks = <K extends Position>(
  scope: HookScope,
  position: K,
  lead: ReadonlyArray<unknown>,
  value: Values[K],
  options: { readonly essential?: boolean } = {},
): Effect.Effect<Values[K], K extends Vetoes ? HookFailed : never> =>
  Effect.gen(function* () {
    const hooks = scope.set.byPosition.get(position)
    if (hooks === undefined) return value
    const row = POSITIONS[position] as Row<Values[K]>
    const timeout = yield* HookTimeout
    let current = value
    for (const hook of hooks) {
      const args = [
        scope.stateFor(hook),
        ...lead.map(copy),
        ...(position === "after_thread_created" ? [] : [copy(current)]),
        { source: { ...scope.set.source } },
      ]
      const outcome = yield* callHook(hook, args, timeout)
      let problem: string
      let late = ""
      if (outcome._tag === "Failure") problem = outcome.failure
      else if (outcome.success._tag === "None") {
        problem = `did not settle within ${Duration.format(timeout)}`
        late = " The hook may still be running, and Spindle cannot undo what it does after this point."
      } else {
        const next = row.accept(outcome.success.value, current)
        if (next !== INVALID) {
          current = next
          continue
        }
        problem = `returned a value that is not ${row.expects}`
      }
      const veto = row.failure === "veto" && options.essential !== true
      yield* Effect.logWarning(
        `Hook ${hook.id} (${position}, ${row.where}) ${problem}. Spindle ${veto ? "refused the change" : row.kept}.${late}`,
      )
      if (veto) return yield* new HookFailed({ hook: hook.id, position, problem })
    }
    return current
  }) as Effect.Effect<Values[K], K extends Vetoes ? HookFailed : never>
