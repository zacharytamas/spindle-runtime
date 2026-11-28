import type { HookToolCall, Message, ToolResult } from "@standardagents/spec"
import { Effect } from "effect"
import type { Registry } from "../registry/Registry.ts"
import type { Stores } from "../store/sqlite.ts"
import type { StreamedCalls } from "./call.ts"
import { countHooks, type HookScope, observeHooks, transformHooks } from "./hooks.ts"
import { commitMessage } from "./messages.ts"
import { argumentsOf } from "./response.ts"
import type { ThreadScope, ToolScope } from "./step.ts"
import {
  checkedResult,
  describe,
  notRun,
  ResultUnreadable,
  resultOf,
  storedResult,
  type ToolCall,
  unstorableResult,
} from "./tools.ts"
import type { PromptSideValue } from "./turn.ts"

export const hookCall = (call: { readonly id: string; readonly name: string }, args: string): HookToolCall => ({
  id: call.id,
  type: "function",
  function: { name: call.name, arguments: args },
})

export const callStarted = (
  hooks: HookScope,
  call: Pick<ToolCall, "name" | "id" | "argumentsText">,
  progress?: string,
) => observeHooks(hooks, "tool_call_started", [hookCall(call, call.argumentsText), progress])

// Hooks section 5. A call that started in a response the loop then discarded is done too, and never ran.
export const streamedHooks = (hooks: HookScope, turn: PromptSideValue): StreamedCalls | undefined =>
  countHooks(hooks, "tool_call_started") > 0 || countHooks(hooks, "tool_call_done") > 0
    ? {
        progressArgument: (name) => turn.tools.get(name)?.tool.value.progressArgument,
        started: (call, progress) => callStarted(hooks, call, progress),
        abandoned: (calls) =>
          Effect.forEach(
            calls,
            (call) =>
              observeHooks(hooks, "tool_call_done", [
                hookCall(call, call.argumentsText),
                {
                  status: "error",
                  error: "Spindle did not run this call, because the model response that held it failed.",
                },
              ]),
            { concurrency: 1, discard: true },
          ),
      }
    : undefined

// Hooks section 5: the branch the tool's own outcome picks, then before_store_tool_result, then the stored
// message, then tool_call_done with what was stored.
export const completeCall = (
  { turn, write }: ToolScope,
  { run, record, observe }: ThreadScope,
  callerSeq: number,
  call: ToolCall,
  outcome: Effect.Effect<ToolResult | undefined, never, Registry | Stores>,
) =>
  Effect.gen(function* () {
    const { hooks } = write
    const result = run.stopAtBoundary() ? undefined : yield* outcome
    const skipped = result === undefined
    const returned = result === undefined ? notRun : checkedResult(result)
    const toolCall = hookCall(call, argumentsOf(call))
    const branched = skipped
      ? returned
      : yield* transformHooks(
          hooks,
          // The tool's own status picks the branch, even when its error data could not be kept.
          result.status === "success" ? "after_tool_call_success" : "after_tool_call_failure",
          [toolCall],
          returned,
        )
    const final = skipped ? returned : yield* transformHooks(hooks, "before_store_tool_result", [toolCall], branched)
    const save = (result: ToolResult) =>
      Effect.try({
        try: () => storedResult(turn, call, result),
        catch: (cause) => new ResultUnreadable({ message: `reading it threw: ${describe(cause)}` }),
      }).pipe(
        Effect.flatMap((message) =>
          commitMessage({ ...write, callerSeq }, message, {
            fields: ["content", "metadata", "attachments"],
            keepErrorCode: !skipped,
            ...(skipped && {
              finish: (redacted: Message) => ({
                ...redacted,
                role: message.role,
                name: message.name ?? null,
                tool_call_id: message.tool_call_id ?? null,
                tool_status: "error" as const,
                content: message.content ?? null,
              }),
            }),
          }),
        ),
      )
    // Runtime section 5.2: a failure between the tool's return and its stored result fails this one call.
    const { message: stored } = yield* save(final).pipe(
      Effect.catchTag(["ValueNotJson", "ResultUnreadable"], (error) => save(unstorableResult(final, error.message))),
    )
    yield* record("persist-results", `${call.id} ${stored.tool_status}`)
    yield* observe({ type: "message", message: stored })
    // Hooks section 5.5: tool_call_done sees the result as the store holds it, after every hook and redaction.
    yield* observeHooks(hooks, "tool_call_done", [toolCall, resultOf(stored)])
    // Storing a result can turn a success into an error, and the stop tool outcome reports what was stored.
    return stored.tool_status == null ? final : { ...final, status: stored.tool_status }
  })
