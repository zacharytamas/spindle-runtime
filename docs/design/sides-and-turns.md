# Sides, turns, and direct execution

**Status.** Settled for milestone M2a on 2026-11-27. Written from Standard Agent Specification 0.2.0, `@standardagents/spec` 0.45.13, and Spindle at `a98fb70`. The section "Decisions the spec leaves open" separates operator choices from implementation details.

Milestone 1 runs one prompt side against one human side. Milestone M2a removes that assumption so Spindle runs every legal 0.2.0 side pairing, counts turns across backings, supports `forceTurn`, and supports direct execution outside a calling tool.

## 1. Sides, turns, and routing

### 1.1 Typed side model

An agent has two explicit sides, `sideA` and `sideB`, each backed by `human`, `prompt`, or `handler`. Both sides human is a definition-time error. The step loop never branches on pairs of backings. It resolves each side into one tagged `SideValue` and dispatches on that value alone.

```typescript
type Side = "a" | "b"

interface HumanSideValue {
  readonly kind: "human"
  readonly side: Side
  readonly role: "assistant" | "user"
  readonly config: HumanSide
}

interface PromptSideValue {
  readonly kind: "prompt"
  readonly side: Side
  readonly role: "assistant" | "user"
  readonly config: PromptSide // stopTool resolved to offered short name
  readonly prompt: Loaded<PromptDefinition>
  readonly model: Loaded<ModelDefinition>
  readonly tools: ReadonlyMap<string, ExposedTool>
}

interface HandlerSideValue {
  readonly kind: "handler"
  readonly side: Side
  readonly role: "assistant" | "user"
  readonly config: HandlerSide
  readonly handler: Loaded<HandlerDefinition>
}

type SideValue = HumanSideValue | PromptSideValue | HandlerSideValue

interface AgentSides {
  readonly agent: Loaded<AgentDefinition>
  readonly a: SideValue
  readonly b: SideValue
}
```

A `TurnController` on the execution owns the active agent name, the active side, any pending `forceTurn` target, and the side-scope cache keyed by `(agentQualifiedName, side)`. Each prompt side builds its `SideScope` (`hooks`, `write`, `toolContext`, `view`, `provider`, `streamed`) lazily on its first turn in the execution. A handler side builds its scope from `agentHooks(agent)` and the agent environment, with no prompt and no provider.

This structure prepares M2b handoffs without changing the loop. When an M2b handoff tool transfers the thread to another agent, it updates `threads.agent_id` in storage and writes the target agent and side onto `TurnController`. The loop never inspects tool kind. At the next turn boundary it reads `TurnController`, loads the new `AgentSides` into the cache, and dispatches the new active `SideValue`.

### 1.2 Rules for sides, perspectives, and execution state

1. `roleOf("a")` is `"assistant"` and `roleOf("b")` is `"user"`, regardless of whether a side is backed by a human, a prompt, or a handler (`specification:threads/messages:b8f7cd7e`).
2. A message with role `"user"` is authored from side B's perspective and targets side A. A message with role `"assistant"` is authored from side A's perspective and targets side B. A message with role `"system"` targets neither side.
3. For any prompt-backed side, `toProviderMessages` renders own-side turns as `assistant`, renders opposite-side turns as `user`, omits opposite-side `tool_calls` and opposite-side `tool` results, and omits an opposite-side message whose `tool_calls` is non-null when it has neither non-empty content nor attachments (`infrastructure:runtime:853d2427`).
4. `Execution` tracks `sideASteps` and `sideBSteps` separately, and `ExecutionState.stepCount` returns their sum. Only completed model steps increment `sideASteps` or `sideBSteps`. A handler turn contributes zero steps.
5. `ExecutionState.currentSide` returns the side whose turn is executing, updated whenever the active side changes. `ExecutionState.promptPath` holds `[prompt.qualifiedName]` during a prompt turn and `[]` during a handler turn or a direct tool execution.
6. `ThreadState.context` is one mutable object created fresh at execution start on `ThreadScope`. Every hook, tool, handler, and inbound delivery hook in that execution reads and mutates the same object (`specification:threads:2ea40632`, `specification:threads:357c07d0`).
7. Mutations to `ThreadState.context` never persist after the execution settles and never appear in `ThreadState.arguments` or `threads.arguments` (`specification:threads:c487ef3f`, `specification:threads:c2a80b35`, `specification:threads:d4e23481`).
8. Handler validation and runtime loading require the `Symbol.for("standardagents.handler")` brand checked by `isHandler` from `@standardagents/spec` (`specification:handlers:cdfccc99`).

### 1.3 What a turn is, durable turn counts, and `maxSessionTurns`

A turn is one side's unit of work in an exchange.

- A **human turn** ends when the human's inbound message is persisted. When control reaches a human-backed side, the execution parks and settles `idle`.
- A **prompt turn** is one or more model steps by a prompt-backed side until a turn-ending condition, a session-ending condition, `forceTurn`, `stop()`, or a failure ends it. A five-step prompt turn counts as five steps toward `maxSteps` and `stepCount`, and as one turn toward `maxSessionTurns`.
- A **handler turn** is one invocation of `handler.execute(state, message)` for one persisted inbound message (`specification:agents:3df00a7e`). It runs zero model steps, builds no provider request, and counts as one turn toward `maxSessionTurns` (`specification:agents:b3f24116`).

Turn counts are durable on the thread row in a new integer column `threads.session_turns` (default `0`). Durability lets `maxSessionTurns` work uniformly on `prompt x human` and `handler x human` threads whose exchanges span separate executions and separate CLI commands, and preserves the count across cooperative `state.execution.stop()`.

9. Completing a prompt turn or a handler turn increments `threads.session_turns` by 1 in SQLite under the owning flow fence (`specification:agents:b3f24116`, `specification:agents:47d9e86c`). Persisting a human message does not increment `threads.session_turns`.
10. When `agent.maxSessionTurns` is set and `session_turns >= maxSessionTurns` at the end of a turn, the runtime ends the session, resets `threads.session_turns` to `0` in the settlement transaction, leaves the thread open (not terminated), and settles `idle` with reason `max_session_turns` (`specification:agents:47d9e86c`, `specification:agents:35afe886`, `infrastructure:runtime:bc5ba253`).
11. A settlement with `max_session_turns` sets `continueIfQueued` to `false`. Queued work stays pending for a waiting sender or the next trigger, which starts a new session with `session_turns` at `0` and history intact.
12. `threads.session_turns` resets to `0` only on a session-ending settlement (`max_session_turns`, `state_stop_session`, M2b `session_stop` and `session_fail`, or a run settling `failed` with `step_error`, `fatal_error`, or `execution_lost`). Settlements that pause or stop execution without ending the session (`stop_on_response`, `stop_tool`, `max_side_steps`, `awaiting_human`, `forced_human_turn`, `handler_idle`, `aborted`, `aborted_by_user`, `max_total_steps`, `max_total_turns`) and a throwing handler (`handler_error`) preserve `threads.session_turns`.
13. When `maxSessionTurns` is omitted, a runtime hard cap `turnCap` (default `1000`, configurable like `stepCap`) bounds total turns in one execution. Reaching `turnCap` settles `idle` with reason `max_total_turns` and leaves queued work pending, preventing an unbounded `handler x handler` livelock that takes zero model steps.

### 1.4 Stop evaluation order and `forceTurn`

`state.execution.forceTurn(side)` validates that `side` is `"a"` or `"b"` and throws `InvalidArguments` otherwise. It checks handle expiration first. Calling `forceTurn` does not abort sibling tool calls in the current model response. It records the requested target side on `TurnController`, with last write winning during a step or handler turn.

14. After all tool calls of a prompt step finish and commit, the loop evaluates boundaries in this exact order.
    1. External or cooperative stop (`stop()` or abort) ends the run `idle` (`aborted` or `aborted_by_user`) and ignores `forceTurn`.
    2. Session-terminal actions (`state.stopSession()`, and M2b `sessionStop` or `sessionFail`) end the session, reset `session_turns` to `0`, and ignore `forceTurn`.
    3. If `forceTurn(target)` was called during the step, the current side's turn ends immediately, `session_turns` increments by 1, and `maxSessionTurns` and `turnCap` are checked. If neither cap fired, control moves to `target`.
    4. Otherwise, evaluate `stopTool`, then `stopOnResponse`, then `maxSteps` (`max_side_steps`). If none fires, the current prompt side takes another step. If one fires, `session_turns` increments by 1, `maxSessionTurns` and `turnCap` are checked, and if neither cap fired, control moves to `otherSide(currentSide)`.
    5. Runtime `stepCap` is checked last, as a safety limit (`infrastructure/runtime.md` section 6), and follows the step-cap decision of `docs/design/thread-ownership.md`. When `run.steps >= stepCap` and nothing would follow the turn, because control passes to a human side and the queue holds no work the execution would take, the reason from items 2 to 4 stands. When the execution would otherwise go on to another step, another automated side, or queued work, it ends `idle` with `max_total_steps`, which tells the operator why that work did not run. `max_session_turns` wins over `max_total_steps`.
15. When control moves to a human-backed side because of `forceTurn`, the run settles `idle` with reason `forced_human_turn`. When control moves to a human-backed side on ordinary prompt turn completion, the run settles `idle` with that prompt turn's reason (`stop_tool`, `stop_on_response`, or `max_side_steps`). When a prompt-backed side wakes with no prompt work and control belongs to a human side, the run settles `idle` with `awaiting_human`.
16. When `forceTurn` targets a prompt-backed side (including the same side that just ran), that side starts a fresh turn with `sideSteps` reset to `0` and runs a model step even if no new message arrived.
17. When `forceTurn` targets a handler-backed side, the runtime delivers the next undelivered inbound message on that side's perspective (such as the message the opposite side just wrote or the next pending queued message for that side). If no undelivered inbound message exists, the runtime never fabricates a message and never redelivers a prior message. It settles `idle` with reason `handler_idle`.
18. On a root thread, calling `state.stopSession(options?)` during an active execution marks the session stopped, stops the execution at the next boundary (giving any remaining sibling tool calls in the same model response `notRun`), resets `threads.session_turns` to `0`, keeps the thread open (not terminated), and settles `idle` with reason `state_stop_session` (`specification:handlers:00d791ec`). Calling `state.stopSession()` when `state.execution` is `null` rejects with an error. Parent `notifyParent` and `status` options remain no-ops on root threads until M3b.

### 1.5 Handler delivery model

A handler side has no step loop, no model request, and no auto-injected reply channel (`specification:handlers:ea88514a`). Its `execute(state, message)` receives a deep copy of the full persisted `Message` and a `ThreadState` scoped to the handler's turn (`specification:handlers:6ce44191`).

Two nullable integer columns on `threads`, `side_a_delivered_seq` and `side_b_delivered_seq` (default `0`), record the highest persisted message sequence dispatched to each handler side.

19. A handler invocation receives one persisted inbound message on its perspective (`role === roleOf(otherSide(side))`), delivered in strictly increasing `seq` order and never concurrently on the same thread (`specification:handlers:0747a620`, `specification:handlers:ab2038a6`).
20. When a handler drains a queued message targeting its side, one SQLite transaction removes that single `pending` queue row, inserts the `Message` row (after agent `before_create_message` hooks), and advances `side_<x>_delivered_seq` to the inserted row's `seq`. Only then does the runtime invoke `handler.execute(state, copyMessage(message))` (`specification:handlers:0747a620`).
21. When a prompt turn hands control to an opposite handler side, the runtime delivers every message that prompt turn persisted in the prompt side's role, in `seq` order, one handler invocation each. This includes an intermediate message that carries `tool_calls`, with or without text. `role: "tool"` results are on no side's perspective and are not delivered. Before each invocation it advances `side_<x>_delivered_seq` to that message's `seq` in a fenced transaction. Each invocation is one handler turn and counts toward `maxSessionTurns` (`specification:handlers:0747a620`, and `specification/handlers.md` section 3 on turn counting).
22. When a handler turn ends cleanly after calling `state.injectMessage` one or more times in its own side's role (`role === roleOf(side)`), those persisted messages trigger the opposite side. If the opposite side is a prompt, one prompt turn sees all of them in its snapshot. If the opposite side is a handler, each message is delivered one at a time in `seq` order after advancing the opposite side's `delivered_seq` before each call.
23. When a handler turn ends cleanly without injecting a message in its own side's role and without calling `forceTurn`, the opposite side does not run. Delivery goes on as in rule 26. Undelivered messages of the peer side's last turn come first, in `seq` order, then pending queue entries. The run settles `idle` with reason `handler_idle` only when no eligible delivery remains.
24. A message added via `injectMessage()` at rest starts no execution and is not retroactively delivered to a handler on a later run.
25. Any return value from `handler.execute` (other than a rejected promise) is ignored. A handler communicates only through `ThreadState` or external userland calls (`specification:handlers:ea88514a`).
26. When `handler.execute` throws synchronously or returns a rejected promise, the turn is marked failed, `session_turns` increments by 1, the inbound message and every write already committed remain persisted, and the message is never redelivered (`specification:handlers:78f43349`). The runtime records a runtime-origin failure entry on `RunOutcome.handlerCalls` and logs it redacted (`specification:handlers:2c8bc235`). The failed turn does not hand off to the opposite side and does not end the session (`specification:handlers:00d791ec`). If neither `maxSessionTurns` nor `turnCap` fired, delivery goes on. Undelivered messages of the peer side's last turn come first, in `seq` order (rule 21), then pending queue entries. A message added by `injectMessage()` at rest is never eligible (rule 24). The run settles `failed` with reason `handler_error`, preserving `threads.session_turns`, only when no eligible delivery remains and the last handler turn threw.

### 1.6 Message and queued tool ownership across sides

The `queue` payload for `kind = "tool"` gains an optional `side: "a" | "b" | null` field.

27. When `queueTool` is called inside an active execution, the queue entry records `side: currentSide`. When `queueTool` is called at rest, the queue entry records `side: null`.
28. When draining a queued tool entry, the runtime picks its owning side `S` as follows. If `entry.side` is non-null, `S` is `entry.side`. Otherwise, if exactly one side is prompt-backed, `S` is that side. Otherwise, if both sides are prompt-backed, `S` is `"a"`. Otherwise, if one side is handler-backed, `S` is that side. Otherwise (`handler x handler`), `S` is `"a"`.
29. When owning side `S` is prompt-backed, the drain stores the synthetic caller message (`role: roleOf(S)`, `content: null`, `tool_calls: [...]`, `prompt: null`, `metadata: { queued: true }`, `result_prompt: S.prompt.qualifiedName`), runs `S`'s tool hooks and tool execution, stores the `role: "tool"` result (`prompt: S.prompt.qualifiedName`), and marks `S` prompted for a model step.
30. When owning side `S` is handler-backed, the drain stores the synthetic caller message (`role: roleOf(S)`, `content: null`, `tool_calls: [...]`, `prompt: null`, `metadata: { queued: true }`, `result_prompt: null`), runs agent-level tool hooks (`tool_call_started`, `after_tool_call_success`/`failure`, `before_store_tool_result`, `tool_call_done`) and tool execution with agent environment scope, and stores the `role: "tool"` result (`prompt: null`). It does not invoke `handler.execute` and does not trigger the opposite side. After draining, if the queue is empty, the run settles `idle` with reason `handler_idle`.
31. While a prompt side `S` drains before a model call, it dequeues consecutive pending entries belonging to `S` (messages targeting `S`, tools owned by `S`, and messages targeting a human opposite side). It stops draining without consuming a queue head that targets an opposite automated side (`prompt` or `handler`) or a `kind = "agent"` entry, leaving that entry at the head for after `S`'s turn ends.
32. `ThreadSupervisor.send` sends with `roleOf(human)` when the agent has a human side, and with `"user"` (side B perspective, targeting side A) when the agent has no human side.

### 1.7 Current modules and functions that assume one prompt side

Every assumption below changes in M2a.

| Module | Symbol | Single-prompt assumption |
|---|---|---|
| `execution/turn.ts` | `Turn`, `sidesOf`, `prepareTurn` | Rejects any pairing except `prompt x human` and `human x prompt`. Loads only one prompt side. |
| `execution/step.ts` | `SideScope`, `prepareSide`, `advance`, `prepareSteps`, `learnSecrets` | Builds one `SideScope` with a per-side `context: {}`, one delivery hook scope hardcoded to `turn.side`, and a single-side loop that always returns on stop instead of switching sides. |
| `execution/drain.ts` | `runQueuedTool`, `drainQueue` | Requires a prompt `SideScope` (`turn.prompt.qualifiedName`, `turn.tools`), drains all queued rows at once, and cannot attribute queued tools by side or run `agent` entries. |
| `execution/Execution.ts` | `Execution` | Tracks only one `#steps` counter, no per-side step counts, no mutable active side, no `forceTurn` target, no handler call log, and no direct-tool watermark. |
| `execution/thread-state.ts` | `ExecutionRecord`, `executionState`, `toolMethods`, `unavailableMethods`, `agentHookScope` | Computes `sideAStepCount`/`sideBStepCount` from one side, throws `notYet` for `forceTurn` and `runAgent`, refuses `invokeTool` outside a calling tool, omits `side` on `queueTool`, and leaves `context` unshared in delivery hooks. |
| `execution/tools.ts` | `ToolContext`, `scopeFor`, `invokeTool`, `storedResult` | Requires `Turn` (with a prompt) and a calling `FunctionTool`. |
| `execution/tool-lifecycle.ts` | `completeCall` | Takes `SideScope` and requires `turn.prompt.qualifiedName` for `storedResult`. |
| `execution/assemble.ts` | `toProviderMessages`, `pastOf` | Emits `{ role: "user", content: "" }` for opposite-side tool-call-only messages, and builds an O(N) `Set<string>` on every turn start. |
| `execution/stop-rules.ts` | `STOP_RULES`, `stopReason` | Evaluates only single-side prompt rules with no turn-boundary or `maxSessionTurns` stage. |
| `execution/ThreadSupervisor.ts` | `ThreadSupervisor`, `send`, `claimWith` | Calls `sidesOf` to require a `human` side in `send`, and has no direct-execution claim path or `runAgent` admission. |
| `execution/trigger.ts` | `atRest` | Calls `prepareTurn` for secrets only on single-prompt agents, and wires neither at-rest `invokeTool` nor `runAgent`. |
| `store/` (`model.ts`, `schema.ts`, `RunStore.ts`, migrations) | `QueueEntry`, `RunStore.claim`, `threads` table | Supports only `message` and `tool` queue kinds, requires pending queue rows to claim, and has no `session_turns` or handler delivery cursor columns. |
| `cli/shared.ts`, `cli/run.ts`, `cli/chat.ts` | `withProject`, `printer`, `messageLines` | Calls `sidesOf` for a single model role and filters printed output to one role. |

`execution/call.ts` and `execution/run-status.ts` are already side-agnostic. `call.ts` needs no structural change, and `run-status.ts` already recognizes `forced_human_turn`, `max_session_turns`, and `handler_idle`.

### 1.8 Where a turn starts, and a waiting sender

Added after the review of pull request 36. Two fixes built from cases each broke other cases, so these rules define both behaviors directly.

61. A side's turn starts immediately after the last message persisted by that side's own previous turn, including that turn's tool results. Every later message is current for the side: a peer's hand-off message, a message a tool or hook injected, a drained queue entry, and a preamble a `before_create_message` hook injected. Every earlier message is past. A side with no previous turn in the thread treats the whole thread as current.
62. Within an execution, the runtime records the `seq` that ends each side's turn when the turn ends. At the start of an execution it derives the same boundary from storage in O(1) statements, from the latest message in the side's role and the tool results that follow it. It never derives the boundary from the latest message of the peer's role.
63. A sender whose message is still `pending` when the run it claimed or waited on settles reclaims the thread only if that run took at least one queue entry, and the settlement was not an operator abort (`aborted_by_user`), `execution_lost`, or termination. Each reclaim therefore consumes an entry, and a sender cannot reclaim without end.
64. When rule 63 does not allow a reclaim, `send()` returns that run's outcome with `stillQueued: true`.
65. When a sender waits on another run that takes its message, `send()` returns the outcome of the run that took the message, not the outcome of the run it first claimed.

---

## 2. Direct execution outside a calling tool

Direct execution covers three paths.

- `state.invokeTool(toolName, args)` called from a hook inside an active execution.
- `state.invokeTool(toolName, args)` called on a handle at rest (including from an at-rest hook such as `after_thread_created` or at-rest `before_create_message`).
- `state.runAgent(agentName)` called on a handle at rest or inside an active execution.

All three paths obey the single-flow-per-thread invariant and commit fencing of `docs/design/thread-ownership.md`.

### 2.1 `invokeTool` from a hook inside an active execution

33. Calling `state.invokeTool(toolName, args)` from a hook inside an active execution runs inside the hook's owning flow without acquiring a new claim and without changing `run_state` (`specification:threads:39260b1a`, `specification:threads:a1ac0a36`).
34. Parameter checks run first. Non-string `toolName` or non-object `args` rejects with `InvalidArguments`. An expired hook handle rejects with `HookExpired` before lookup or tracking.
35. The call registers as pending on `owner.track("tool " + toolName)` in the same synchronous step before lookup, variable checks, or argument validation, matching `thread-ownership.md` M1c-4 rule 3.
36. Because a hook has no calling tool and no `uses` list, `uses` does not restrict the hook's target. The target name resolves in the hook definition's namespace (`state.from`), so a packed hook resolves tools inside its own package and entry points.
37. The invoked tool runs with the active prompt's environment scope when the hook ran during a prompt turn, or the agent's environment scope when the hook ran during inbound delivery or a handler turn.
38. The invoked tool receives a fresh `ThreadState` with its own `Callback` (bounded by `--tool-timeout` when configured), sharing the owning flow's `Execution`, `context`, `secrets`, `hooks`, and `abortSignal`, with `caller` set to the target tool so its own `uses` list governs further nested calls.
39. Writes made by the invoked tool inherit the enclosing hook's write depth (`call.depth`), so a `before_create_message` hook cannot bypass `NestedWriteLimit` (default 8) by invoking a tool that calls `injectMessage`.
40. Direct `invokeTool` from a hook stores no synthetic `tool_calls` row and no `role: "tool"` row, and runs no tool-storage hooks (`tool_call_started`, `after_tool_call_*`, `before_store_tool_result`, `tool_call_done`). Unknown tools, schema errors, missing required variables, throws, and bad return shapes resolve to `{ status: "error", error }`. A stop or abort before tool entry resolves to `notRun`.

### 2.2 `invokeTool` on a handle at rest

41. Calling `state.invokeTool(toolName, args)` when `state.execution` is `null` validates `toolName` and `args` first (rejecting with `InvalidArguments` on bad types) and checks handle expiration (rejecting with `HookExpired` or `HandleExpired`).
42. Before claiming, the supervisor runs `RunStore.recoverLost(threadId)` so a dead holder from a crashed process settles `failed` (`execution_lost`) and does not block the call.
43. `RunStore.claimDirect(threadId, claim)` executes in one `BEGIN IMMEDIATE` transaction. If the thread is missing, it rejects with `ThreadNotFound`. If `terminated_at` is non-null, it rejects with `ThreadTerminated` without changing thread state or calling user code (`specification:threads:9090af10`, `infrastructure:runtime:dc7d7df0`).
44. If `run_state` is `"running"`, `claimDirect` makes no change and `invokeTool` rejects immediately with a typed `ThreadBusy` error naming the thread. A second at-rest `invokeTool` caller arriving while a direct tool or agent run holds the thread always fails fast with `ThreadBusy` rather than deadlocking or polling without a queue entry.
45. The supervisor reserves the new `flowId` in `flows` before `claimDirect` begins, as `claimWith` does, so the control poll cannot settle the claim as `execution_lost` while it is being registered. It removes the reservation when `claimDirect` refuses or fails. If `run_state` is `"idle"` or `"failed"`, `claimDirect` transitions the thread to `run_state = "running"`, `run_reason = null`, `run_since = now`, `holder_id = holder.id`, `flow_id` to the reserved id, and returns the current maximum `pending` queue sequence `watermark` (`0` if empty).
46. After a successful claim, the supervisor attaches the minimal `Execution` to `live` under the reserved flow. Its `ExecutionState` exposes `flowId`, `currentSide` (`"a"` unless side A is human, in which case `"b"`), `stepCount = 0`, `sideAStepCount = 0`, `sideBStepCount = 0`, `promptPath = []`, live `messageHistory`, `abortSignal`, and `stop()`. Calling `forceTurn` inside a minimal tool execution is a no-op because no turn loop follows.
47. The tool runs with agent-level hooks, agent environment scope, fresh single-execution `context`, `secrets` learned from the agent and tool declarations, and `caller` set to the target tool. When invoked from an at-rest hook, writes made by the tool inherit that hook's write depth (`call.depth`) so `NestedWriteLimit` still bounds recursion. It resolves `toolName` in `state.from` (the thread's agent namespace, or the hook's namespace when called from an at-rest hook). It stores no `tool_calls` or `role: "tool"` message and does not increment `threads.session_turns`.
48. All mutations performed by the tool or its hooks carry `{ kind: "handle", flowId }` and pass the SQLite flow fence of `thread-ownership.md`. Before settling, the minimal execution waits for every tracked nested callback to return or time out under decision 5 of `thread-ownership.md`.
49. When the tool completes (returning either `status: "success"` or `status: "error"`), the minimal execution settles `idle` with reason `direct_tool`, releases its claim, and resolves the caller's promise with the `ToolResult` (`specification:threads:39260b1a`, `specification:threads:a1ac0a36`). An unexpected store error or defect settles `failed` with `fatal_error` and rejects the caller's promise.
50. The minimal execution never drains queue entries that were already pending before `claimDirect`. Work admitted to the queue while the minimal execution held the thread (`seq > watermark`) appends to `queue` durably without starting a concurrent flow. After the minimal execution settles cleanly (or after abort cleanup finishes) and if the thread is not terminated and the supervisor is not closing, the supervisor starts a fresh normal execution via `claimWith` whenever a pending entry with `seq > watermark` exists. The `invokeTool` promise resolves immediately upon minimal settlement and does not wait for that follow-up execution.
51. `supervisor.stop(threadId)` sets the stop flag on the minimal execution. `supervisor.abort(threadId)` fires `abortSignal`, revokes the tool's handle, holds the claim until live callbacks settle (except on terminate, orderly exit, or forced recovery), settles `idle` (`aborted_by_user` or `aborted`), and resolves `invokeTool` to `notRun` (if aborted before entry) or `{ status: "error", error: CLOSING.aborted }`.
52. `terminate()` during `invokeTool` at rest marks `terminated_at` and settles `idle` (`aborted`) in one SQLite transaction, displaces the local execution, refuses further tool writes with `FlowEnded(terminated)`, and resolves `invokeTool` to `{ status: "error", error: CLOSING.terminated }`.
53. If the process crashes while `invokeTool` at rest runs, `recoverLost` settles `failed` (`execution_lost`), removes the dead holder row, preserves committed writes and pending queue entries, and never re-runs the tool.

### 2.3 `runAgent` on a handle at rest or during an execution

`runAgent(agentName)` is declared by `@standardagents/spec` and omitted from the 0.2.0 spec prose (see section 6). Spindle implements it as a durable queued trigger so it obeys single-flow-per-thread exclusion and crash recovery cleanly.

54. `state.runAgent(agentName)` validates that `agentName` is a non-empty string (rejecting with `InvalidArguments`), checks handle expiration (rejecting with `HookExpired`, `HandleExpired`, or `ExecutionEnded`), and resolves `agentName` in `state.from` (rejecting with `SetupError` if no such agent exists).
55. `runAgent` admits a durable queue entry `{ kind: "agent", agentName: resolved.qualifiedName }` through `RunStore.admit`, passing the handle's `WriteOrigin`. On a terminated thread, `RunStore.admit` rejects with `ThreadTerminated` without inserting a queue row or claiming the thread (`specification:threads:9090af10`, `infrastructure:runtime:dc7d7df0`).
56. When the thread is at rest (`idle` or `failed`), `RunStore.admit` inserts the queue row and atomically claims the thread (`run_state = "running"`, `run_reason = null`, `holder_id`, `flow_id`). The supervisor forks the background execution and `runAgent` resolves `Promise<void>` immediately after commit without waiting for the execution to finish.
57. When another execution (normal run, handler turn, `runAgent`, or `invokeTool` at rest) already holds the thread, `RunStore.admit` appends the `agent` queue row and returns `claimed: false`. `runAgent` resolves `Promise<void>` after commit without starting a concurrent flow. The queued entry runs in FIFO order when the active flow drains it or when a successor claims it after settlement.
58. Dequeuing an `agent` entry runs `RunStore.consumeQueued(threadId, seq, { flowId })` in one fenced SQLite transaction. It switches `TurnController` to the named agent as a run-scoped override without modifying `threads.agent_id`.
59. The target agent's entry side is side A if side A is prompt-backed, else side B if side B is prompt-backed. That prompt side immediately runs a turn over the thread's existing history without requiring a new inbound message. If the target agent has no prompt-backed side, the override stays active for any following queued message in the same flow, or settles `idle` (`handler_idle`) if the queue is empty.
60. `stop()`, `abort()`, and `terminate()` govern a `runAgent` execution identically to any other execution. A crash before `consumeQueued` leaves the entry pending for the next trigger. A crash after `consumeQueued` settles `failed` (`execution_lost`), closes any open tool calls, and never auto-replays the lost run.

### 2.4 Fit with `docs/design/thread-ownership.md`

The ownership matrix in `docs/design/thread-ownership.md` gains two rows and changes no existing invariant.

| Operation and origin | Rest | Running | Aborting | Failed | Terminated | Condition |
|---|---|---|---|---|---|---|
| Direct `invokeTool` (`claimDirect`, at-rest handle) | A | R (`ThreadBusy`) | R (`ThreadBusy`) | A | R (`ThreadTerminated`) | Recovers dead holder first. Sets `running` and `flow_id`. |
| `runAgent` admission (`admit` kind `agent`, external or flow) | A (claims) | A/F (queues) | A (queues) / F (refused) | A (claims) | R (`ThreadTerminated`) | Same authority rules as `queueMessage` and `queueTool`. |

Every write inside a direct `invokeTool` or `runAgent` execution carries a non-null `flowId` and obeys decision 1 (commit fencing), decision 5 (wait for live callbacks on abort), decision 6 (handle expiry), and decision 7 (open-call repair via `flow_id` and `caller_seq`).

---

## 3. Failure modes

| Actor and failure | Boundary | Required runtime behavior |
|---|---|---|
| Model returns empty text, violates `toolChoice`, or provider fails with retryable error | Prompt step | Retry up to `retries`, honoring `Retry-After` and stopping on `stop()`/`abort()`. Abandon streamed `tool_call_started` hooks via `tool_call_done`. Settle `failed` (`step_error`) on exhaustion, storing no response and resetting `session_turns` to `0`. |
| Model sends non-JSON tool arguments or unknown/unoffered tool name | Prompt step | Persist response as returned, write a `role: "tool"` error result for that call, continue sibling calls and the loop. |
| Provider fails with non-retryable error or missing credential | Prompt setup or step | Settle `failed` (`step_error` or `fatal_error`), preserve earlier committed turns, reset `session_turns` to `0`. |
| Two prompt sides never stop | Turn boundary | Stop at `maxSessionTurns` (`idle`, `max_session_turns`, reset `session_turns` to `0`). If omitted, stop at `stepCap` (`idle`, `max_total_steps`). Respect `stop()`, `abort()`, and `terminate()` at every boundary. |
| Two handler sides (or prompt and handler) never stop | Turn boundary | Stop at `maxSessionTurns` (`idle`, `max_session_turns`). If omitted, stop at `turnCap` (`idle`, `max_total_turns`). Respect `stop()`, `abort()`, and `terminate()`. |
| Opposite prompt side emits tool-call-only message or reuses call ID | Context assembly | Omit opposite-side tool-call-only messages with no text/attachments and pair results by `caller_seq`, so the active model never sees opposite-side calls or empty user turns. |
| Handler throws synchronously or rejects | Handler turn | Persist inbound message and prior writes. Advance `session_turns` by 1. Log runtime-origin failure in `RunOutcome.handlerCalls` and redacted warning/error log. Never redeliver. Do not trigger opposite side. Deliver the peer side's remaining messages, then the next queued entry, if any. Settle `failed` (`handler_error`), preserving `session_turns`, only when no eligible delivery remains. |
| Handler never returns (or awaits a blocking child needing an inbound message on this thread) | Handler turn | Keep thread `running` and hold claim. Queue incoming messages durably without concurrent invocation. Other threads proceed. Escape via `abort()` (revokes handle, holds until return or orderly exit), `terminate()`, or `spindle recover --force`. |
| Handler returns wrong shape (string, object, sync value, throwing thenable) | Handler turn | Ignore any fulfilled return value without reading properties on it. If `.then` throws or rejects, take the handler-throw path. |
| Handler calls back into the thread | Handler turn | `injectMessage` writes under owning flow (own-role injections trigger opposite side after turn returns, never re-enter mid-turn). `queueMessage`, `queueTool`, and `runAgent` append durably to `queue`. `invokeTool` runs nested inside owning flow. `forceTurn` sets next target. `stop` ends execution after turn. `terminate` ends immediately. Opening a separate `stateAtRest` and calling `invokeTool` rejects with `ThreadBusy`. |
| Handler mutates `message` argument or retains expired `state` | Handler turn | Pass `copyMessage(message)` so cache stays intact. Mark `Callback` finished on return/throw so late writes reject with `HandleExpired`. |
| Hook calls `invokeTool`, tool throws or times out or loops recursively | Hook execution | Tool errors return `{ status: "error" }` to the hook. `HookTimeout` expires the hook's handle while `owner.track` holds the flow until the tool finishes or hits `--tool-timeout`. Nested writes inherit `call.depth` and stop at `NestedWriteLimit`. |
| Hook or tool calls `forceTurn` with invalid side | Turn step or hook | Throw `InvalidArguments` synchronously. A tool's throw becomes a tool error result. A hook's throw fails that hook by its hook policy. |
| Direct `invokeTool` at rest throws, returns wrong shape, or hangs | Direct execution | Throws and bad shapes resolve to `{ status: "error" }` and settle `idle` (`direct_tool`). A hung tool holds `running` until `--tool-timeout`, `abort()`, `terminate()`, orderly exit, or `spindle recover --force`. Second `invokeTool` callers get `ThreadBusy`. |
| Crash between side A prompt turn and side B turn | Turn boundary | Recovery sees dead holder, finds zero open calls, settles `failed` (`execution_lost`), resets `session_turns` to `0`, keeps committed messages and pending queue, and starts no successor. |
| Crash after handler dequeue+persist+cursor advance, before or during `execute` | Handler turn | Inbound message is persisted, queue row is gone, `delivered_seq` covers it. Recovery settles `failed` (`execution_lost`) and never redelivers the message. |
| Crash before handler dequeue or before `runAgent` `consumeQueued` | Queue head | Queue row stays `pending`. Recovery settles `failed` (`execution_lost`) and preserves the entry for the next trigger. |
| Crash mid-step on side B prompt with open tool calls | Prompt tool step | `RunStore.closeCalls` selects by `(thread_id, flow_id)` regardless of message role and closes side B's open calls with `CLOSING.lost`. |
| Crash during `invokeTool` at rest | Direct execution | Recovery settles `failed` (`execution_lost`), removes dead holder, keeps pending queue entries, and never re-runs the tool. |

---

## 4. Decisions the spec leaves open

### Decided on 2026-11-27

The operator chose decisions 4 and 5. The root took the recommendation on 1, 3, 6 and 7, and decision 2 follows the spec text, which are readings of the spec or implementation choices. Each decision below is the rule.

1. **Durable `session_turns` and whether human turns count.** Recommend storing `session_turns` durably on `threads` and counting only completed prompt turns and handler turns (not human messages), resetting to `0` on session end. Alternative is an ephemeral per-execution counter (which makes `maxSessionTurns` inert on `prompt x human`), or counting human messages too (which causes odd `maxSessionTurns` values to stop before the agent answers).
2. **Messages delivered from a multi-step prompt turn to an opposite handler side.** Every message the prompt turn persisted in its own role is delivered, one invocation each, in persistence order (rule 21). Handlers section 4 requires one invocation for each inbound message on the side's perspective, and a tool-call message in the prompt side's role is one. A handler that wants only replies with text checks `message.tool_calls` itself. Each invocation is a handler turn, so a five-step prompt turn opposite a handler can use up to five handler turns of `maxSessionTurns`. An earlier draft delivered only the final message. Review on pull request 34 showed that it breaks `specification:handlers:0747a620`.
3. **Second caller to `stateAtRest.invokeTool` while the thread is running.** Recommend failing fast with typed `ThreadBusy` (after checking `recoverLost`), matching `queueTool` as the async alternative and avoiding self-reentry deadlocks. Alternative is waiting in memory until the thread settles and then claiming.
4. **Effect of `runAgent(otherAgent)` on `threads.agent_id`.** Recommend a run-scoped agent override that leaves `threads.agent_id` unchanged so background finalizers without a human side do not permanently break a human-facing thread. Alternative is permanently reassigning `threads.agent_id` like a handoff.
5. **Run status when a throwing handler is the final turn of an execution and the queue is empty.** Recommend settling `failed` (`handler_error`) while preserving `threads.session_turns` (and still continuing through any queued messages before settling), so `spindle run` and `status()` distinguish handler errors from model `step_error` and surface them loudly without ending the session. Alternative is always settling `idle` (`handler_idle`) and surfacing the failure only in the execution log.
6. **Root-thread `state.stopSession()` in M2a.** `specification/handlers.md` (including M2a ledger id `specification:handlers:00d791ec`) requires handlers to end sessions via `state.stopSession()`, whereas `docs/plans/milestones.md` placed session tools in M2b and `ledger.json` placed `specification:threads:6a8e34ca` in M3b. Recommend shipping root-thread `state.stopSession()` in M2a (deferring parent `notifyParent`/`status` to M3b) so `00d791ec` closes cleanly. Alternative is leaving `stopSession()` unavailable in M2a and keeping `00d791ec` partial until M2b/M3b.
7. **Optional handler timeout flag.** Recommend no new `--handler-timeout` flag in M2a (keep `abort()`, `terminate()`, and `spindle recover --force` as the escapes, matching the spec's omission of a handler deadline). Alternative is adding an opt-in `--handler-timeout` flag alongside `--tool-timeout`.

### Implementation details decided by this note

- Runtime reason codes `direct_tool` (`idle`, direct `invokeTool` at rest), `max_total_turns` (`idle`, runtime hard cap of `1000` turns per execution preventing `handler x handler` livelocks without `maxSessionTurns`), and `handler_error` (`failed`, final handler turn threw on an empty queue while keeping the session open).
- Handler-side queued tools store synthetic caller and tool-result rows with `prompt: null` and run agent hooks, keeping crash repair uniform across all side backings.
- `forceTurn` targeting a handler side with no undelivered inbound message settles `idle` (`handler_idle`) without fabricating a message. `forceTurn` during a minimal direct `invokeTool` execution is a no-op.
- Handler validation and lookup enforce `isHandler` (`Symbol.for("standardagents.handler")`).
- `HistoryView` tracks `turnStartSeq: number` instead of a `Set<string>` of past message IDs.

---

## 5. Performance guard

The project keeps one performance guard. The cost of a step (and a turn) must not grow with the length of the thread.

1. **One shared `History` cache per execution.** `makeHistory(threadId)` lives on `ThreadScope` and is shared by side A and side B. Switching sides never discards or re-reads the `messages` table. Each own insert appends in O(1) via `Chunk.append` and checks `threads.revision` in one primary-key lookup.
2. **O(1) past-history boundary.** Replace `past: Set<string>` in `HistoryView` with `turnStartSeq: number`. Testing whether a stored row belongs to past history becomes `row.seq < view.turnStartSeq`, avoiding O(N) set allocation on every turn switch in `prompt x prompt`. When `includeChat` and `includePastTools` are both `false` and no `filter_messages` hook is active, `toProviderMessages` slices from the first row at or above `turnStartSeq` as rule 61 defines it (found by scanning backwards from the tail in O(turn length)), avoiding touching older history rows.
3. **Handler turns read zero history.** Dequeueing a queued message or receiving a peer side's message passes the `Message` directly without calling `MessageStore.history()`. History loads only if user code inside the handler reads `state.execution.messageHistory` or `state.getMessages()`.
4. **O(1) turn counters and delivery cursors.** `threads.session_turns`, `threads.side_a_delivered_seq`, and `threads.side_b_delivered_seq` are integer columns on `threads`, read and updated by primary key. Spindle never counts turns or scans delivered messages with a query over `messages`.
5. **Direct `invokeTool` reads zero history.** `claimDirect` reads the `threads` row and `max(seq)` on the indexed `queue_by_thread` index. It never reads `messages` unless the invoked tool asks for history.
6. **Bounded SQL statements per step and per turn.** Every prompt step, handler turn, side switch, and direct tool execution performs a constant number of SQL statements independent of thread length.

---

## 6. To record in `DIVERGENCES.md` during the build

Do not edit `packages/conformance/DIVERGENCES.md` in this design PR. Record these entries when the build PRs land.

1. **`ThreadState.runAgent` exists only in `@standardagents/spec`.** `@standardagents/spec` 0.45.13 declares `runAgent(agentName: string): Promise<void>`. Standard Agent Specification 0.2.0 text never mentions `runAgent`. Record Spindle's durable queue admission and run-scoped agent behavior.
2. **`ThreadState.invokeTool` at rest (update existing entry).** Replace the M1 deferral note with the M2a `claimDirect` / `direct_tool` / `ThreadBusy` / watermark behavior once M2a-3 lands.
3. **Queued tool ownership on non-prompt sides (update existing entry).** Update "A queued tool call is a call of the prompt side" to describe side-attributed queued tools and handler-side queued tools with `prompt: null` once M2a-2 lands.
4. **Runtime reason codes `max_total_turns`, `direct_tool`, and `handler_error`.** Document all three runtime-defined reason codes under "Limits that Spindle sets where the spec allows one".

---

## 7. Ledger mapping

### M2a ledger statements (all 20 owed by M2a)

| Requirement ID | Status before M2a | Design section and rules |
|---|---|---|
| `specification:handlers:0747a620` | planned | §1.5 rules 19, 20 |
| `specification:handlers:ab2038a6` | planned | §1.5 rule 19, §3 |
| `specification:handlers:78f43349` | planned | §1.5 rule 26, §3 |
| `specification:handlers:dea03971` | planned | §3 (hung handler and cross-thread isolation) |
| `specification:handlers:2c8bc235` | planned | §1.5 rule 26, §3 |
| `specification:handlers:00d791ec` | planned | §1.4 rule 18, §1.5 rule 26 |
| `specification:handlers:ea88514a` | planned | §1.5 rule 25 |
| `specification:threads:2ea40632` | planned | §1.2 rule 6 |
| `specification:threads:c487ef3f` | planned | §1.2 rule 7 |
| `specification:threads:357c07d0` | planned | §1.2 rule 6 |
| `specification:threads:c2a80b35` | planned | §1.2 rule 7 |
| `specification:threads:d4e23481` | planned | §1.2 rule 7 |
| `specification:threads:39260b1a` | partial | §2.1 rule 33, §2.2 rule 49 |
| `specification:threads:a1ac0a36` | partial | §2.1 rule 33, §2.2 rule 49 |
| `specification:threads:9090af10` | partial | §2.2 rule 43, §2.3 rule 55 |
| `specification:agents:b3f24116` | planned | §1.3 rule 9 |
| `specification:agents:47d9e86c` | planned | §1.3 rules 9, 10 |
| `specification:agents:3df00a7e` | planned | §1.3, §1.5 rules 22, 23 |
| `infrastructure:runtime:dc7d7df0` | partial | §2.2 rule 43, §2.3 rule 55 |
| `infrastructure:runtime:853d2427` | planned | §1.2 rule 3, §3 |

### M1 partial statements closed or advanced by M2a

- Closed by M2a. `specification:agents:35afe886`, `infrastructure:runtime:bc5ba253`, `specification:handlers:cdfccc99`, `specification:handlers:6ce44191`, `specification:threads/messages:b8f7cd7e`.
- Advanced by M2a (remain partial for M2b or M5). `infrastructure:runtime:d80e4c71` (waits on M2b session tools), `infrastructure:runtime:7b5d1f06` (waits on M2b session tools), `specification:threads/execution-state:1a0354bc` (adds `forced_human_turn`, `max_session_turns`, `handler_idle`, `state_stop_session`; waits on M2b `session_stop` and M5 client handling).
