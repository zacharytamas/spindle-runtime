import type { AttachmentRef, Message, PromptToolConfig, ThreadState, ToolResult } from "@standardagents/spec"
import { Data, Effect, Result } from "effect"
import type { Definition } from "../registry/Registry.ts"
import type { NewMessage } from "../store/model.ts"
import { Callback, type PendingCallbacks } from "./callback.ts"
import { type EnvScope, resolveEnv } from "./env.ts"
import { type FunctionTool, isFunctionTool, type Loaded, lookup, type Turn } from "./turn.ts"

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown> | undefined
  readonly argumentsText: string
  readonly problem: string | undefined
}

export interface ToolContext {
  readonly pending: PendingCallbacks
  readonly turn: Turn
  readonly stateFor: (
    tool: Loaded<FunctionTool>,
    entry: PromptToolConfig | undefined,
    callback: Callback,
  ) => ThreadState
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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

export const scopeFor = (turn: Turn, entry: PromptToolConfig | undefined): EnvScope => ({
  agent: turn.agent.value.env,
  toolEntry: entry?.env,
  prompt: turn.prompt.value.env,
})

const optionalString = (value: unknown) => value === undefined || typeof value === "string"

const isToolResult = (value: unknown): value is ToolResult =>
  isRecord(value) &&
  (value.status === "success" || value.status === "error") &&
  optionalString(value.result) &&
  optionalString(value.error) &&
  optionalString(value.error_code) &&
  optionalString(value.stack) &&
  (value.error_data === undefined || isRecord(value.error_data)) &&
  (value.attachments === undefined || Array.isArray(value.attachments))

const FIELDS = ["status", "result", "error", "error_code", "error_data", "stack", "attachments"] as const

// Reads each field of a returned result once into a plain object, so that a getter on the result runs here and
// later reads cannot throw.
const fieldsOf = (value: unknown) => {
  if (!isRecord(value)) return value
  const fields: Record<string, unknown> = {}
  for (const key of FIELDS) {
    const field = value[key]
    if (field !== undefined) fields[key] = field
  }
  return fields
}

const isAttachmentRef = (value: unknown): value is AttachmentRef =>
  isRecord(value) && value.type === "file" && typeof value.id === "string" && typeof value.path === "string"

const isNewAttachment = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && typeof value.data === "string"

// Tools section 9: arguments are validated against the declared schema before execute runs, and anything the
// tool throws or returns becomes a ToolResult rather than a failure of the loop.
export const executeTool = Effect.fn("executeTool")(function* (
  tool: Loaded<FunctionTool>,
  input: unknown,
  stateFor: (callback: Callback) => ThreadState,
  pending: PendingCallbacks,
  scope: EnvScope,
) {
  const name = tool.definition.qualifiedName
  for (const variable of tool.value.variables ?? [])
    if (variable.required && (yield* resolveEnv(scope, variable.name)) === undefined)
      return failed(`Tool ${name} requires variable ${variable.name}, which has no value`)
  const schema = tool.value.args ?? null
  let args: unknown
  if (schema !== null) {
    const parsed = yield* Effect.result(Effect.tryPromise({ try: () => schema.safeParseAsync(input), catch: describe }))
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
  const state = stateFor(callback)
  if (state.execution?.stopped) return undefined
  const returned = yield* Effect.result(
    Effect.tryPromise({
      try: () =>
        callback.invoke(pending, `tool ${name}`, () =>
          schema === null ? tool.value.execute(state) : tool.value.execute(state, args),
        ),
      catch: describe,
    }),
  )
  if (Result.isFailure(returned)) return failed(`Tool ${name} threw: ${returned.failure}`)
  let result: unknown
  try {
    result = fieldsOf(returned.success)
  } catch (cause) {
    return failed(`Reading the result of tool ${name} threw: ${describe(cause)}`)
  }
  if (!isToolResult(result))
    return failed(
      `Tool ${name} returned a value that is not a ToolResult. A tool returns an object with status "success" or "error".`,
    )
  return result
})

// A ToolResult read once into a plain object, or undefined when the value is not one or reading it throws.
export const readResult = (value: unknown): ToolResult | undefined => {
  try {
    const result = fieldsOf(value)
    return isToolResult(result) ? result : undefined
  } catch {
    return undefined
  }
}

export const runToolCall = Effect.fn("runToolCall")(function* (context: ToolContext, call: ToolCall) {
  if (call.problem !== undefined) return failed(call.problem)
  const exposed = context.turn.tools.get(call.name)
  if (exposed === undefined) {
    const offered = [...context.turn.tools.keys()]
    return failed(
      `The model called ${call.name}, which prompt ${context.turn.prompt.definition.qualifiedName} does not offer.${offered.length === 0 ? "" : ` It offers ${offered.join(", ")}.`}`,
    )
  }
  return yield* executeTool(
    exposed.tool,
    call.arguments,
    (callback) => context.stateFor(exposed.tool, exposed.entry, callback),
    context.pending,
    scopeFor(context.turn, exposed.entry),
  )
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
    if (
      entry === name ||
      (target !== undefined && (yield* lookup("tool", entry, caller.definition))?.definition === target.definition)
    )
      return undefined
  return `Tool ${caller.definition.qualifiedName} does not list ${name} in uses`
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
  const target = yield* lookup<unknown>("tool", name, from)
  const outside = caller === undefined ? undefined : yield* outsideUses(caller, name, target)
  if (outside !== undefined) return yield* new QueueRefused({ message: outside })
  if (target === undefined || !isFunctionTool(target.value))
    return yield* new QueueRefused({ message: yield* notAFunctionTool(name, from, "queueTool") })
  return target.definition.qualifiedName
})

// Tools section 2.1: invokeTool returns an error result for a target outside a supplied uses list.
export const invokeTool = Effect.fn("invokeTool")(function* (
  context: ToolContext,
  caller: Loaded<FunctionTool>,
  name: string,
  input: unknown,
) {
  const target = yield* lookup<unknown>("tool", name, caller.definition)
  const outside = yield* outsideUses(caller, name, target)
  if (outside !== undefined) return failed(outside)
  if (target === undefined || !isFunctionTool(target.value))
    return failed(yield* notAFunctionTool(name, caller.definition, "invokeTool"))
  const tool = target as Loaded<FunctionTool>
  const entry = [...context.turn.tools.values()].find((exposed) => exposed.tool.definition === tool.definition)?.entry
  return (
    (yield* executeTool(
      tool,
      input,
      (callback) => context.stateFor(tool, entry, callback),
      context.pending,
      scopeFor(context.turn, entry),
    )) ?? notRun
  )
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

// Runtime section 5.2: an attachment that cannot be stored is dropped, and the result becomes a tool error that
// keeps the tool's own text and says what was dropped. A new file needs the thread file system, which arrives in M3.
// createMessage redacts the message after Spindle adds its notes, so a secret that is a word of a note is removed too.
export const storedResult = (turn: Turn, call: ToolCall, result: ToolResult): NewMessage => {
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
    prompt: turn.prompt.definition.qualifiedName,
    status: "completed",
    tool_status: dropped.length === 0 ? result.status : "error",
    content: [contentOf(result), ...dropped].filter((part) => part !== "").join("\n\n"),
    attachments: refs.length === 0 ? null : refs,
    metadata: {
      ...(result.error_code === undefined ? {} : { error_code: result.error_code }),
      // A copy runs every getter of the error data here, inside the caller's try, so one that throws makes the
      // result unstorable rather than failing the write that redacts it.
      ...(result.error_data === undefined ? {} : { error_data: structuredClone(result.error_data) }),
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
    ...(isRecord(error_data) ? { error_data } : {}),
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
