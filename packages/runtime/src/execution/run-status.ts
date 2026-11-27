import type { ThreadRunState, ThreadStatus } from "@standardagents/spec"

// Execution State section 4.2. A code from one list never settles a run into the other state. A code from neither
// list is a runtime's own and may settle either way.
export const IDLE_REASONS: ReadonlyArray<string> = [
  "stop_on_response",
  "stop_tool",
  "awaiting_human",
  "forced_human_turn",
  "hook_blocked",
  "aborted",
  "aborted_by_user",
  "session_stop",
  "state_stop_session",
  "max_total_steps",
  "max_side_steps",
  "max_session_turns",
  "handler_idle",
]

export const FAILED_REASONS: ReadonlyArray<string> = [
  "step_error",
  "repeated_tool_error",
  "session_fail",
  "fatal_error",
  "execution_lost",
]

export type RunEvent =
  | { readonly type: "start" }
  | { readonly type: "settle"; readonly state: "idle" | "failed"; readonly reason: string }
  | { readonly type: "lose" }

type EventType = "start" | "settle idle" | "settle failed" | "lose"

const typeOf = (event: RunEvent): EventType => (event.type === "settle" ? `settle ${event.state}` : event.type)

// Execution State section 4.3. A run starts from idle or failed, and only a running run settles or is lost. Every
// other pair is illegal, so a second start of a running thread is refused.
export const TRANSITIONS: { readonly [S in ThreadRunState]: ReadonlyArray<EventType> } = {
  idle: ["start"],
  failed: ["start"],
  running: ["settle idle", "settle failed", "lose"],
}

const reasonFits = (state: ThreadRunState, reason: string) =>
  !(state === "idle" ? FAILED_REASONS : IDLE_REASONS).includes(reason)

// The status after the event, or undefined when the event is illegal from this status. since moves only when the
// state or the reason changes.
export const transition = (from: ThreadStatus, event: RunEvent, now: number): ThreadStatus | undefined => {
  if (!TRANSITIONS[from.state].includes(typeOf(event))) return undefined
  const next =
    event.type === "start"
      ? { state: "running" as const, reason: null }
      : event.type === "lose"
        ? { state: "failed" as const, reason: "execution_lost" }
        : { state: event.state, reason: event.reason }
  if (next.reason !== null && !reasonFits(next.state, next.reason)) return undefined
  const same = next.state === from.state && next.reason === (from.reason ?? null)
  return { ...next, since: same ? from.since : now }
}

// The text of the error result that Spindle stores for a call whose execution ended before its result was stored.
// A call whose tool may have acted is never run again.
export const CLOSING = {
  lost: "Spindle lost the execution before it stored a result for this call. It does not know whether the tool ran, and it did not run the tool again.",
  failed:
    "The execution failed before this call's result was stored. It does not know whether the tool ran, and it did not run the tool again.",
  aborted:
    "The execution was aborted before this call's result was stored. The tool may have acted before it stopped, and Spindle did not run the call again.",
  terminated:
    "The thread was terminated before this call's result was stored. The tool may have acted before it stopped, and Spindle did not run the call again.",
} as const
