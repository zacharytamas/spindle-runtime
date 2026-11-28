import type { AttachmentRef, Message, PromptToolConfig, ThreadState, ToolResult } from "@standardagents/spec"
import { Data, Duration, Effect, Predicate, Result, type Scope } from "effect"
import type { Definition } from "../registry/definition.ts"
import type { NewMessage } from "../store/model.ts"
import { Callback } from "./callback.ts"
import type { Execution } from "./Execution.ts"
import { type EnvScope, learnVariable, resolveEnv, type Secrets } from "./env.ts"
import type { WriteContext } from "./messages.ts"
import { isPlain } from "./redact.ts"
import {
  type AutomatedSide,
  type FunctionTool,
  isFunctionTool,
  type Loaded,
  lookup,
  type PromptSideValue,
} from "./turn.ts"

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown> | undefined
  readonly argumentsText: string
  readonly problem: string | undefined
}

export type ToolEnvironment = AutomatedSide | { readonly kind: "agent"; readonly agent: AutomatedSide["agent"] }
export interface ToolContext<T extends ToolEnvironment = ToolEnvironment> {
  readonly secrets: Secrets
  readonly scope: Scope.Scope
  readonly toolTimeout: ((qualifiedName: string) => Duration.Duration | undefined) | undefined
  readonly execution: Execution
  readonly secrets: Secrets
  readonly turn: T
  readonly stateFor: (
    tool: Loaded<FunctionTool>,
    entry: PromptToolConfig | undefined,
    callback: Callback,
    writeCall: WriteContext["call"],
  ) => ThreadState
}

// A thrown value that is not an Error, such as a plain object, is shown as JSON where it can be.
export const describe = (cause: unknown) => {
  if (cause instanceof Error) return cause.message
  try {
    return JSON.stringify(cause) ?? String(cause)
  } catch {
    return String(cause)
  }
}

export class ResultUnreadable extends Data.TaggedError("ResultUnreadable")<{ readonly message: string }> {}

export const notRun = Object.freeze({
  status: "error" as const,
  error: "Spindle did not run this call, because the execution was stopped before the call started.",
})

export const failed = (error: string): ToolResult => ({ status: "error", error })

export const scopeFor = (turn: ToolEnvironment, entry: PromptToolConfig | undefined): EnvScope => ({
  agent: turn.agent.value.env,
  toolEntry: entry?.env,
  prompt: turn.kind === "prompt" ? turn.prompt.value.env : undefined,
})

const optionalString = (value: unknown) => value === undefined || typeof value === "string"

export const isToolResult = (value: unknown): value is ToolResult =>
  Predicate.isObject(value) &&
  (value.status === "success" || value.status === "error") &&
  optionalString(value.result) &&
  optionalString(value.error) &&
  optionalString(value.error_code) &&
  optionalString(value.stack) &&
  (value.error_data === undefined || Predicate.isObject(value.error_data)) &&
  (value.attachments === undefined || Array.isArray(value.attachments))

const FIELDS = ["status", "result", "error", "error_code", "error_data", "stack", "attachments"] as const

// Reads each field of a returned result once into a plain object, so that a getter on the result runs here and
// later reads cannot throw.
const fieldsOf = (value: unknown) => {
  if (!Predicate.isObject(value)) return value
  const fields: Record<string, unknown> = {}
  for (const key of FIELDS) {
    const field = value[key]
    if (field !== undefined) fields[key] = field
  }
  return fields
}

const isAttachmentRef = (value: unknown): value is AttachmentRef =>
  Predicate.isObject(value) && value.type === "file" && typeof value.id === "string" && typeof value.path === "string"

const isNewAttachment = (value: unknown): value is Record<string, unknown> =>
  Predicate.isObject(value) && typeof value.data === "string"

const skipped = Symbol("skipped")

export const learnToolVariables = Effect.fnUntraced(function* (
  scope: EnvScope,
  tool: Loaded<FunctionTool>,
  secrets: Secrets,
) {
  for (const variable of tool.value.variables ?? []) {
    if (variable.type === "secret") secrets.names.add(variable.name)
    yield* learnVariable(scope, variable.name, secrets)
  }
})

const missingVariable = Effect.fnUntraced(function* (tool: Loaded<FunctionTool>, scope: EnvScope) {
  for (const variable of tool.value.variables ?? []) {
    if (!variable.required) continue
    const value = yield* Effect.result(resolveEnv(scope, variable.name))
    if (Result.isFailure(value)) return value.failure.message
    if (value.success === undefined)
      return `Tool ${tool.qualifiedName} requires variable ${variable.name}, which has no value`
  }
})

// Tools section 9: arguments are validated against the declared schema before execute runs, and anything the
// tool throws or returns becomes a ToolResult rather than a failure of the loop.
export const executeTool = Effect.fn("executeTool")(function* (
  context: ToolContext,
  tool: Loaded<FunctionTool>,
  entry: PromptToolConfig | undefined,
  input: unknown,
  onExecute?: () => void,
  writeCall?: WriteContext["call"],
) {
  const name = tool.qualifiedName
  const scope = scopeFor(context.turn, entry)
  yield* learnToolVariables(scope, tool, context.secrets)
  const missing = yield* missingVariable(tool, scope)
  if (missing) return failed(missing)
  const schema = tool.value.args ?? null
  let args: unknown
  if (schema !== null) {
    const validate = () => schema.safeParseAsync(input)
    // Interrupting a nested invocation can return notRun while its user-supplied validator is still running.
    const parsed = yield* Effect.result(
      Effect.tryPromise({
        try: () => (onExecute ? context.execution.call(new Callback(), `tool ${name}`, validate) : validate()),
        catch: describe,
      }),
    )
    if (Result.isFailure(parsed)) return failed(`Validating the arguments of ${name} threw: ${parsed.failure}`)
    if (!parsed.success.success) {
      const issues = parsed.success.error.issues
        .map((issue) => `${issue.path.length === 0 ? "(arguments)" : issue.path.join(".")}: ${issue.message}`)
        .join("; ")
      return failed(`The arguments for ${name} do not match its schema. ${issues}`)
    }
    args = parsed.success.data
  }
  const callback = new Callback()
  const state = context.stateFor(tool, entry, callback, writeCall)
  const work = Effect.tryPromise({
    try: () =>
      context.execution.call(callback, `tool ${name}`, () => {
        if (state.execution?.stopped || context.execution.signal.aborted) return skipped
        onExecute?.()
        return schema === null ? tool.value.execute(state) : tool.value.execute(state, args)
      }),
    catch: (cause) => `Tool ${name} threw: ${describe(cause)}`,
  })
  const timeout = context.toolTimeout?.(name)
  const bounded =
    timeout === undefined
      ? work
      : callback.within(work, timeout, () => `Tool ${name} timed out after ${Duration.format(timeout)}`, context.scope)
  const returned = yield* Effect.result(bounded)
  if (Result.isFailure(returned)) return failed(returned.failure)
  if (returned.success === skipped) return undefined
  const read = yield* Effect.result(Effect.try({ try: () => readResult(returned.success), catch: describe }))
  if (Result.isFailure(read)) return failed(`Reading the result of tool ${name} threw: ${read.failure}`)
  const result = read.success
  if (result === undefined)
    return failed(
      `Tool ${name} returned a value that is not a ToolResult. A tool returns an object with status "success" or "error".`,
    )
  return result
})

export const readResult = (value: unknown): ToolResult | undefined => {
  const result = fieldsOf(value)
  return isToolResult(result) ? result : undefined
}

export const runToolCall = Effect.fn("runToolCall")(function* (context: ToolContext<PromptSideValue>, call: ToolCall) {
  if (call.problem !== undefined) return failed(call.problem)
  const exposed = context.turn.tools.get(call.name)
  if (exposed === undefined) {
    const offered = [...context.turn.tools.keys()]
    return failed(
      `The model called ${call.name}, which prompt ${context.turn.prompt.qualifiedName} does not offer.${offered.length === 0 ? "" : ` It offers ${offered.join(", ")}.`}`,
    )
  }
  return yield* executeTool(context, exposed.tool, exposed.entry, call.arguments)
})

// Tools section 2.1: a supplied uses list limits the targets a tool may invoke or queue by name. An empty list
// permits none, and an omitted list permits any.
const outsideUses = Effect.fnUntraced(function* (
  caller: Loaded<FunctionTool>,
  name: string,
  target: Loaded<unknown> | undefined,
) {
  const uses = caller.value.uses
  if (uses === undefined || uses === null) return undefined
  for (const entry of uses)
    if (entry === name || (target !== undefined && (yield* lookup("tool", entry, caller)) === target)) return undefined
  return `Tool ${caller.qualifiedName} does not list ${name} in uses`
})

const notAFunctionTool = Effect.fnUntraced(function* (name: string, from: Definition | undefined, method: string) {
  const other =
    (yield* lookup("prompt", name, from)) !== undefined || (yield* lookup("agent", name, from)) !== undefined
  return other
    ? `${name} is a prompt or an agent. In this version of Spindle, ${method} reaches function tools only.`
    : `No tool named ${name} is defined`
})

export class QueueRefused extends Data.TaggedError("QueueRefused")<{ readonly message: string }> {}

// Tools section 2.1: queueTool throws for a target outside a supplied uses list. It also throws for a name that
// resolves to no function tool, so that nothing is queued that could never run. The result is the target's qualified
// name, which finds the same definition when the queue is drained.
export const queueTarget = Effect.fn("queueTarget")(function* (
  caller: Loaded<FunctionTool> | undefined,
  from: Definition | undefined,
  name: string,
) {
  const target = yield* lookup("tool", name, from)
  const outside = caller === undefined ? undefined : yield* outsideUses(caller, name, target)
  if (outside !== undefined) return yield* new QueueRefused({ message: outside })
  if (!isFunctionTool(target))
    return yield* new QueueRefused({ message: yield* notAFunctionTool(name, from, "queueTool") })
  return target.qualifiedName
})

// Tools section 2.1: invokeTool returns an error result for a target outside a supplied uses list.
export const invokeTool = Effect.fn("invokeTool")(function* (
  context: ToolContext,
  from: Definition | undefined,
  caller: Loaded<FunctionTool> | undefined,
  name: string,
  input: unknown,
  onExecute: () => void,
  writeCall?: WriteContext["call"],
) {
  const target = yield* lookup("tool", name, from)
  const outside = caller === undefined ? undefined : yield* outsideUses(caller, name, target)
  if (outside !== undefined) return failed(outside)
  if (!isFunctionTool(target)) return failed(yield* notAFunctionTool(name, from, "invokeTool"))
  const entry =
    context.turn.kind === "prompt"
      ? [...context.turn.tools.values()].find((exposed) => exposed.tool === target)?.entry
      : undefined
  const env = scopeFor(context.turn, entry)
  for (const variable of target.value.variables ?? []) {
    if (variable.type === "secret") context.secrets.names.add(variable.name)
    yield* learnVariable(env, variable.name, context.secrets)
  }
  return (yield* executeTool(context, target, entry, input, onExecute, writeCall)) ?? notRun
})

export const redactAttachment = (item: Record<string, unknown>, redact: (text: string) => string) => ({
  ...item,
  ...(typeof item.name === "string" ? { name: redact(item.name) } : {}),
  ...(typeof item.description === "string" ? { description: redact(item.description) } : {}),
})

const contentOf = (result: ToolResult) =>
  result.status === "success"
    ? (result.result ?? "")
    : [result.error, result.result].filter((part) => part !== undefined && part !== "").join("\n\n")

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many)

// Check prototypes before copying fields. Remember each copy so shared getters run once and cycles reach the store.
const copyErrorData = (value: unknown, copies = new Map<object, object>()): unknown => {
  if (value === null || typeof value !== "object") return structuredClone(value)
  const existing = copies.get(value)
  if (existing !== undefined) return existing
  if (!isPlain(value)) throw new TypeError("error_data must be a plain JSON object")
  if (Array.isArray(value)) {
    const copy = new Array<unknown>(value.length)
    copies.set(value, copy)
    // Only indexed elements contribute to the stored JSON array.
    Array.prototype.forEach.call(value, (item: unknown, index: number) => {
      copy[index] = copyErrorData(item, copies)
    })
    return copy
  }
  const copy = {}
  copies.set(value, copy)
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: copyErrorData(Reflect.get(value, key), copies),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return copy
}

// A hook receives a structured clone, which strips a prototype. Checking here, before any hook, keeps a class
// instance from reaching the store as its own fields, and reads each getter of the tool's data once.
export const checkedResult = (result: ToolResult): ToolResult => {
  if (result.error_data === undefined) return result
  try {
    return { ...result, error_data: copyErrorData(result.error_data) as typeof result.error_data }
  } catch (cause) {
    return unstorableResult(result, `reading it threw: ${describe(cause)}`)
  }
}

// Runtime section 5.2: an attachment that cannot be stored is dropped, and the result becomes a tool error that
// keeps the tool's own text and says what was dropped. A new file needs the thread file system, which arrives in M3.
// createMessage redacts the message after Spindle adds its notes, so a secret that is a word of a note is removed too.
export const storedResult = (turn: AutomatedSide, call: ToolCall, result: ToolResult): NewMessage => {
  const attachments: ReadonlyArray<unknown> = result.attachments ?? []
  const refs = attachments.filter(isAttachmentRef).map((item) => ({ ...item }))
  const fresh = attachments.filter(isNewAttachment)
  const odd = attachments.length - refs.length - fresh.length
  const dropped = [
    ...(fresh.length === 0
      ? []
      : [
          `Spindle dropped the new file ${fresh.map((item) => String(item.name)).join(", ")}, because this version cannot store a new file. The thread file system arrives in M3.`,
        ]),
    ...(odd === 0
      ? []
      : [
          `Spindle dropped ${odd} ${plural(odd, "attachment that is", "attachments that are")} neither a file reference nor a new file.`,
        ]),
  ]
  return {
    role: "tool",
    name: call.name,
    tool_call_id: call.id,
    prompt: turn.kind === "prompt" ? turn.prompt.qualifiedName : null,
    status: "completed",
    tool_status: dropped.length === 0 ? result.status : "error",
    content: [contentOf(result), ...dropped].filter((part) => part !== "").join("\n\n"),
    attachments: refs.length === 0 ? null : refs,
    metadata: {
      ...(result.error_code === undefined ? {} : { error_code: result.error_code }),
      ...(result.error_data === undefined ? {} : { error_data: copyErrorData(result.error_data) }),
    },
  }
}

// The result that a stored tool message holds, in the shape a tool returns it.
export const resultOf = (message: Message): ToolResult => {
  const text = message.content ?? ""
  const { error_code, error_data } = message.metadata ?? {}
  return {
    ...(message.tool_status === "error" ? { status: "error", error: text } : { status: "success", result: text }),
    ...(message.attachments == null ? {} : { attachments: message.attachments }),
    ...(typeof error_code === "string" ? { error_code } : {}),
    ...(Predicate.isObject(error_data) ? { error_data } : {}),
  }
}

// Runtime section 5.2: a result that fails between the tool's return and the store becomes a tool error for its
// call. It keeps the tool's own text and error code, and drops its attachments and error data.
export const unstorableResult = (result: ToolResult, reason: string): ToolResult => {
  const parts = [
    ...((result.attachments ?? []).length === 0 ? [] : ["attachments"]),
    ...(result.error_data === undefined ? [] : ["error data"]),
  ]
  const note = `Spindle dropped the ${parts.length === 0 ? "data" : parts.join(" and ")} of this result, because ${reason}`
  return {
    status: "error",
    error: [result.error ?? "", note].filter((part) => part !== "").join("\n\n"),
    ...(result.result === undefined ? {} : { result: result.result }),
    ...(result.error_code === undefined ? {} : { error_code: result.error_code }),
  }
}
