import type { AttachmentRef, PromptToolConfig, ThreadState, ToolResult } from "@standardagents/spec"
import { Effect, Result } from "effect"
import type { NewMessage } from "../store/ThreadStore.ts"
import { type EnvScope, resolveEnv } from "./env.ts"
import { mapStrings } from "./redact.ts"
import { type FunctionTool, isFunctionTool, type Loaded, lookup, type Turn } from "./turn.ts"

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: Record<string, unknown> | undefined
  readonly argumentsText: string
  readonly problem: string | undefined
}

export interface ToolContext {
  readonly turn: Turn
  readonly stateFor: (tool: Loaded<FunctionTool>, entry: PromptToolConfig | undefined) => ThreadState
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

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

const isAttachmentRef = (value: unknown): value is AttachmentRef =>
  isRecord(value) && value.type === "file" && typeof value.id === "string" && typeof value.path === "string"

const isNewAttachment = (value: unknown) => isRecord(value) && typeof value.data === "string"

// Tools section 9: arguments are validated against the declared schema before execute runs, and anything the
// tool throws or returns becomes a ToolResult rather than a failure of the loop.
export const executeTool = Effect.fn("executeTool")(function* (
  tool: Loaded<FunctionTool>,
  input: unknown,
  state: ThreadState,
  scope: EnvScope,
) {
  const name = tool.definition.qualifiedName
  for (const variable of tool.value.variables ?? [])
    if (variable.required && (yield* resolveEnv(scope, variable.name)) === undefined)
      return failed(`Tool ${name} requires variable ${variable.name}, which has no value`)
  const schema = tool.value.args ?? null
  let args: unknown
  if (schema !== null) {
    const parsed = yield* Effect.result(
      Effect.tryPromise({ try: () => schema.safeParseAsync(input), catch: (cause) => cause }),
    )
    if (Result.isFailure(parsed))
      return failed(`Validating the arguments of ${name} threw: ${describe(parsed.failure)}`)
    if (!parsed.success.success) {
      const issues = parsed.success.error.issues
        .map((issue) => `${issue.path.length === 0 ? "(arguments)" : issue.path.join(".")}: ${issue.message}`)
        .join("; ")
      return failed(`The arguments for ${name} do not match its schema. ${issues}`)
    }
    args = parsed.success.data
  }
  const returned = yield* Effect.result(
    Effect.tryPromise({
      try: () => (schema === null ? tool.value.execute(state) : tool.value.execute(state, args)),
      catch: (cause) => cause,
    }),
  )
  if (Result.isFailure(returned)) return failed(`Tool ${name} threw: ${describe(returned.failure)}`)
  if (!isToolResult(returned.success))
    return failed(
      `Tool ${name} returned a value that is not a ToolResult. A tool returns an object with status "success" or "error".`,
    )
  return returned.success
})

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
    context.stateFor(exposed.tool, exposed.entry),
    scopeFor(context.turn, exposed.entry),
  )
})

// Tools section 2.1: a supplied uses list limits the targets a tool may invoke by name, and invokeTool returns
// an error result for a target outside it.
export const invokeTool = Effect.fn("invokeTool")(function* (
  context: ToolContext,
  caller: Loaded<FunctionTool>,
  name: string,
  input: unknown,
) {
  const target = yield* lookup<unknown>("tool", name, caller.definition)
  const uses = caller.value.uses
  if (uses !== undefined && uses !== null) {
    let allowed = false
    for (const entry of uses)
      if (
        entry === name ||
        (target !== undefined && (yield* lookup("tool", entry, caller.definition))?.definition === target.definition)
      )
        allowed = true
    if (!allowed) return failed(`Tool ${caller.definition.qualifiedName} does not list ${name} in uses`)
  }
  if (target === undefined || !isFunctionTool(target.value)) {
    const other =
      (yield* lookup("prompt", name, caller.definition)) !== undefined ||
      (yield* lookup("agent", name, caller.definition)) !== undefined
    return failed(
      other
        ? `${name} is a prompt or an agent. In this version of Spindle, invokeTool reaches function tools only.`
        : `No tool named ${name} is defined`,
    )
  }
  const tool = target as Loaded<FunctionTool>
  const entry = [...context.turn.tools.values()].find((exposed) => exposed.tool.definition === tool.definition)?.entry
  return yield* executeTool(tool, input, context.stateFor(tool, entry), scopeFor(context.turn, entry))
})

const redactAttachment = (item: Record<string, unknown>, redact: (text: string) => string) => ({
  ...item,
  ...(typeof item.name === "string" ? { name: redact(item.name) } : {}),
  ...(typeof item.description === "string" ? { description: redact(item.description) } : {}),
})

// Threads section 2.3: a result is redacted in its string values only. The status, the error code, every property
// name, and the parts of an attachment that the runtime reads back keep their values.
export const redactResult = (result: ToolResult, redact: (text: string) => string): ToolResult => ({
  ...result,
  ...(result.result === undefined ? {} : { result: redact(result.result) }),
  ...(result.error === undefined ? {} : { error: redact(result.error) }),
  ...(result.error_data === undefined ? {} : { error_data: mapStrings(result.error_data, redact) }),
  ...(result.attachments === undefined
    ? {}
    : {
        attachments: result.attachments.map((item: unknown) =>
          isRecord(item) ? redactAttachment(item, redact) : item,
        ) as NonNullable<ToolResult["attachments"]>,
      }),
})

const contentOf = (result: ToolResult) =>
  result.status === "success"
    ? (result.result ?? "")
    : [result.error, result.result].filter((part) => part !== undefined && part !== "").join("\n\n")

// A new file needs the thread file system, which arrives in M3. Until then such a result becomes an error.
export const storedResult = (turn: Turn, call: ToolCall, result: ToolResult): NewMessage => {
  const attachments = result.attachments ?? []
  const fresh = attachments.filter(isNewAttachment)
  const odd = attachments.filter((item) => !isNewAttachment(item) && !isAttachmentRef(item))
  const base = {
    role: "tool" as const,
    name: call.name,
    tool_call_id: call.id,
    prompt: turn.prompt.definition.qualifiedName,
    status: "completed" as const,
  }
  if (fresh.length > 0 || odd.length > 0)
    return {
      ...base,
      tool_status: "error",
      content:
        odd.length > 0
          ? `Tool ${call.name} returned an attachment that is neither a file reference nor a new file`
          : `Tool ${call.name} returned a new file attachment (${fresh.map((item) => String(item.name)).join(", ")}). This version of Spindle cannot store a new file, because the thread file system arrives in M3.`,
    }
  const refs = attachments.filter(isAttachmentRef)
  return {
    ...base,
    tool_status: result.status,
    content: contentOf(result),
    attachments: refs.length === 0 ? null : refs,
    metadata: {
      ...(result.error_code === undefined ? {} : { error_code: result.error_code }),
      ...(result.error_data === undefined ? {} : { error_data: result.error_data }),
    },
  }
}
