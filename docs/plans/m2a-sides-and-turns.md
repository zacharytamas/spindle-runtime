# Sides, turns, and direct execution (M2a)

Draft plan written on 2026-11-27 against `main` at `a98fb70`. The behavioral design is in `docs/design/sides-and-turns.md`. The scope comes from `docs/plans/milestones.md`.

Milestone M2a closes all 20 M2a ledger statements, closes 5 M1 partial statements that waited on M2a, adds the missing spec statements listed below to the ledger, and leaves the runtime ready for M2b handoffs and prompt tools.

## How to read this

- A box is checked only when the thing it names is true on `main`.
- The seven rules of `docs/plans/milestones.md` apply. The ones that shape this plan are the structure bar in every brief, short stacks, tests before the build, review depth by risk, and the performance guard.
- The three pull requests run in order (`M2a-1`, then `M2a-2`, then `M2a-3`), each starting from `main` after the prior one lands (or stacked at most 2 deep while the lower PR is in review). Running sequentially avoids migration number collisions and rebase churn in `thread-state.ts`, `RunStore.ts`, and `ledger.json`.

## Program checklist

### Order and limits

- [ ] At most three pull requests are open at a time, stacked at most 2 deep.
- [ ] Operator decisions 1 to 7 in `docs/design/sides-and-turns.md` are confirmed before `M2a-1` starts.
- [ ] `M2a-1` starts from `main` and lands green before `M2a-2` starts from `main`. `M2a-3` starts from `main` after `M2a-2` lands.
- [ ] Each pull request adds at most one migration with the next sequential number (`0007`, `0008`, `0009`).

### Roles

- [ ] GPT-6.2 Astra builds. Gemini 4 Neon writes the tests that come before a build, and reads what the risk of a change calls for.
- [ ] For each of `M2a-1`, `M2a-2`, and `M2a-3`, a Gemini 4 Neon writer commits failing conformance and unit tests first, from `docs/design/sides-and-turns.md` and the spec text. The Astra builder implements until they pass, and records the reason in the pull request for any test it changes.
- [ ] Every pull request changes lifetimes or durable turn/claim state and gets a thirty-minute Gemini 4 Neon reading review plus a behavior audit after the build.
- [ ] Every brief carries the clean-room rule, the Effect v4 rule, the rule against Grok models, the light-check rule, the structure bar (named modules, shared state, function size), and the rule that no process is left behind.

### Checks, for every pull request

- [ ] One test file while iterating. The full `pnpm check` and `bun --bun run check` once at the end.
- [ ] `pnpm fallow` reports no issue (keeping unit size within `.fallowrc.json` limits).
- [ ] The ledger line changes only by the statements the pull request names (plus any curated statements from the missing list below that the PR adds).
- [ ] The performance guard holds. A 50-step probe on a 5,000-message thread shows step cost and SQL statement count do not grow with thread length.
- [ ] Bot threads are read against the head, answered, and resolved before the root reports the pull request ready.

---

## Side model, shared context, two prompt sides, `maxSessionTurns`, and `forceTurn` (M2a-1)

Base is `main`. Introduces the typed `SideValue` union (`human`, `prompt`, `handler`), `TurnController` (ready for M2b handoffs without loop branching on tool kind), shared execution `context`, per-side step counts, durable `session_turns`, `prompt x prompt` alternating turns, `maxSessionTurns`, `forceTurn`, and O(1) `turnStartSeq` history slicing.

### Scope

- Replace single-side `Turn` and `sidesOf` with `SideValue` and `AgentSides` in `turn.ts`, keeping `handler` loading as a stubbed variant completed in `M2a-2`.
- Move `context` onto `ThreadScope` so inbound delivery hooks, side A, side B, and nested calls share one mutable object per execution and drop it at settlement.
- Track `sideASteps`, `sideBSteps`, active `currentSide`, and `TurnController` on `Execution`.
- Add migration `0007_session_turns.ts` adding `session_turns INTEGER NOT NULL DEFAULT 0` on `threads`, with fenced increment on turn completion and reset on session-ending settlement.
- Run two prompt-backed sides (`prompt x prompt`) in one execution, alternating turns on `stopOnResponse`, `stopTool`, `maxSteps`, or `forceTurn` until `maxSessionTurns`, `stepCap`, `stop()`, or failure.
- Implement `state.execution.forceTurn(side)` with validation (`InvalidArguments`), exact boundary precedence, and `forced_human_turn` when forcing a human side.
- Update `assemble.ts` so `toProviderMessages` omits opposite-side tool-call-only messages with no text/attachments and uses `turnStartSeq` instead of allocating a `Set<string>` of past message IDs.
- Update `drain.ts` so a prompt side pauses draining at a queue head targeting an opposite automated side.
- Update `ThreadSupervisor.send`, `trigger.ts`, and `cli/` (`shared.ts`, `run.ts`, `chat.ts`) so agents with two prompt sides run through `send`, `spindle run`, and `spindle send`.

### Modules it may touch

- `packages/runtime/src/execution/turn.ts`
- `packages/runtime/src/execution/step.ts`
- `packages/runtime/src/execution/Execution.ts`
- `packages/runtime/src/execution/thread-state.ts`
- `packages/runtime/src/execution/assemble.ts`
- `packages/runtime/src/execution/stop-rules.ts`
- `packages/runtime/src/execution/drain.ts`
- `packages/runtime/src/execution/ThreadSupervisor.ts`
- `packages/runtime/src/execution/trigger.ts`
- `packages/runtime/src/store/migrations/0007_session_turns.ts` (new), `sqlite.ts`, `database.ts`, `schema.ts`, `model.ts`, `RunStore.ts`
- `packages/runtime/src/cli/shared.ts`, `run.ts`, `chat.ts`
- `packages/conformance/requirements.extra.json`, `requirements.json`, `ledger.json`, and scenario/test files

### Shared state it may change

- `threads.session_turns` column in SQLite (migration `0007_session_turns.ts`).
- `Execution` fields (`sideASteps`, `sideBSteps`, `currentSide`, `TurnController` pending side).
- `ThreadScope.context` shared across sides and delivery hooks.

### Ledger IDs closed

- M2a IDs (7). `specification:threads:2ea40632`, `specification:threads:c487ef3f`, `specification:threads:357c07d0`, `specification:threads:c2a80b35`, `specification:threads:d4e23481`, `specification:agents:47d9e86c`, `infrastructure:runtime:853d2427`.
- M1 partials closed (2). `specification:agents:35afe886`, `infrastructure:runtime:bc5ba253`.
- M1 partials advanced (3). `infrastructure:runtime:d80e4c71`, `infrastructure:runtime:7b5d1f06`, `specification:threads/execution-state:1a0354bc`.
- Newly curated statements added from the missing list below. `forceTurn` and two prompt sides conversing.

### Tests written first (Gemini 4 Neon)

- [ ] Conformance scenarios (`packages/conformance/src/scenarios/sides.ts`, new) covering `prompt x prompt` alternation A to B to A with reused tool call IDs, hidden opposite-side tool-call-only messages, independent `sideAStepCount`/`sideBStepCount`, `maxSessionTurns` on both `prompt x prompt` and multi-send `prompt x human` (verifying reset for a new session), `stepCap` stopping an uncapped `prompt x prompt` loop, and `forceTurn` targeting prompt, same side, human (`forced_human_turn`), and invalid side.
- [ ] Conformance scenarios for `state.context` shared across delivery hooks, side A, side B, and nested tools, never leaking into `state.arguments`, and cleared on the next execution.
- [ ] Unit tests (`packages/runtime/test/execution/stop-rules.test.ts`, `packages/runtime/test/store/runs.test.ts`) verifying turn-boundary precedence, `session_turns` durability and reset rules, and `turnStartSeq` O(1) filtering.
- [ ] Crash-between-turns test verifying side B's open calls close with `CLOSING.lost` and `session_turns` resets on `execution_lost`.

### Review depth and completion

- [ ] Behavior audit of every rule in §1.1 to §1.4 of `docs/design/sides-and-turns.md`, plus a thirty-minute Gemini 4 Neon reading review of `Execution.ts`, `step.ts`, and `RunStore.ts` settlement and `session_turns` durability.
- [ ] `pnpm check`, `bun --bun run check`, `pnpm fallow`, and step-probe check on a 5,000-message thread pass.

---

## Handler-backed sides, handler-compatible tool drain, and root `stopSession` (M2a-2)

Base is `main` after `M2a-1` lands. Activates `HandlerSideValue` across all handler pairings (`handler x human`, `human x handler`, `prompt x handler`, `handler x prompt`, `handler x handler`), enforces the `defineHandler` brand, implements one-at-a-time durable handler delivery and failure semantics, adds side-attributed queued tools for handler sides, and implements root-thread `state.stopSession()`.

### Scope

- Enforce `isHandler` (`Symbol.for("standardagents.handler")`) in `registry/check-definition.ts` and `turn.ts`.
- Add migration `0008_handler_delivery.ts` adding `side_a_delivered_seq INTEGER NOT NULL DEFAULT 0` and `side_b_delivered_seq INTEGER NOT NULL DEFAULT 0` on `threads`.
- Implement handler turn execution in `step.ts` (zero model steps, `promptPath: []`, full `copyMessage(message)`, agent hooks, shared `context`, `Callback` lifetime tracking, `handlerCalls` log on `RunOutcome`, `turnCap` default `1000` with `max_total_turns`).
- Implement atomic dequeue + message persist + `delivered_seq` advance in `MessageStore.insertMessage` / `RunStore`, and fenced `delivered_seq` advance before peer-produced handler delivery.
- Implement handler failure semantics (inbound message and prior writes stay persisted, runtime-origin failure logged, never redelivered, session continues through remaining queue, `failed` / `handler_error` with preserved `session_turns` when queue is empty).
- Add optional `side` to queued tool payloads (`model.ts`, `schema.ts`, `thread-state.ts`), generalize `tools.ts` and `tool-lifecycle.ts` for nullable prompt attribution, and support draining handler-side queued tools (`prompt: null`, agent hooks, `handler_idle`).
- Implement root-thread `state.stopSession()` (settling `idle` / `state_stop_session`, resetting `session_turns`, leaving thread open, rejecting at rest).
- Update `DIVERGENCES.md` for queued tool ownership on non-prompt sides, `max_total_turns`, and `handler_error`.

### Modules it may touch

- `packages/runtime/src/registry/check-definition.ts`
- `packages/runtime/src/execution/turn.ts`
- `packages/runtime/src/execution/step.ts`
- `packages/runtime/src/execution/drain.ts`
- `packages/runtime/src/execution/Execution.ts`
- `packages/runtime/src/execution/tools.ts`
- `packages/runtime/src/execution/tool-lifecycle.ts`
- `packages/runtime/src/execution/thread-state.ts`
- `packages/runtime/src/store/migrations/0008_handler_delivery.ts` (new), `sqlite.ts`, `database.ts`, `model.ts`, `schema.ts`, `MessageStore.ts`, `RunStore.ts`
- `packages/runtime/src/cli/shared.ts`, `run.ts`, `chat.ts`
- `packages/conformance/DIVERGENCES.md`, `requirements.extra.json`, `requirements.json`, `ledger.json`, and scenario/test files

### Shared state it may change

- `threads.side_a_delivered_seq` and `threads.side_b_delivered_seq` columns (migration `0008_handler_delivery.ts`).
- `queue` tool payload schema (adding optional `side`).
- `RunOutcome.handlerCalls` and `Execution` turn counter / `stopSession` flag.

### Ledger IDs closed

- M2a IDs (9). `specification:handlers:0747a620`, `specification:handlers:ab2038a6`, `specification:handlers:78f43349`, `specification:handlers:dea03971`, `specification:handlers:2c8bc235`, `specification:handlers:00d791ec`, `specification:handlers:ea88514a`, `specification:agents:b3f24116`, `specification:agents:3df00a7e`.
- M1 partials closed (3). `specification:handlers:cdfccc99`, `specification:handlers:6ce44191`, `specification:threads/messages:b8f7cd7e`.
- M1 partials advanced (1). `specification:threads/execution-state:1a0354bc`.
- Newly curated statements added from the missing list below. Handler execution state, full persisted message delivery, single-invocation turn model, handler throw persistence and continuation, and handler `ThreadState` capabilities.

### Tests written first (Gemini 4 Neon)

- [ ] Conformance scenarios (`packages/conformance/src/scenarios/handlers.ts`, new) covering `handler x human`, `human x handler`, `prompt x handler`, `handler x prompt`, and `handler x handler` pairings, exactly-once in-order delivery of queued messages, serialized non-concurrent execution while messages queue, cross-thread non-blocking while one handler hangs, throwing handler logging runtime-origin error without redelivery while continuing to the next queued message, ignored return values and no auto-reply channel, handler turn counting as 0 steps and 1 session turn toward `maxSessionTurns`, `turnCap` stopping an uncapped `handler x handler` ping-pong, handler calling `stopSession()` to end the session without terminating the thread, and handler-side `queueTool` execution.
- [ ] Crash-recovery tests (`packages/runtime/test/cli/ownership.test.ts` or `packages/runtime/test/execution/ownership.test.ts`) killing a process during a handler invocation and verifying recovery settles `execution_lost` and never redelivers the failed message.
- [ ] Validation test (`packages/runtime/test/registry/validate.test.ts`) rejecting an unbranded plain object exported from `agents/handlers/`.

### Review depth and completion

- [ ] Thirty-minute Gemini 4 Neon reading review of handler lifetime, durable `delivered_seq` atomicity, crash non-redelivery, re-entrant callbacks, and abort hold behavior, plus a behavior audit against §1.5, §1.6, and §3 of `docs/design/sides-and-turns.md`.
- [ ] `pnpm check`, `bun --bun run check`, `pnpm fallow`, and 5,000-message handler turn probe pass (verifying zero `messages` table scans per handler turn).

---

## Direct execution outside a calling tool (M2a-3)

Base is `main` after `M2a-2` lands. Enables `invokeTool` from hooks inside an execution, `invokeTool` on a handle at rest (and from at-rest hooks), and `runAgent` on handles at rest or inside an execution, with full claim, status, watermark wakeup, `ThreadBusy`, abort, crash recovery, and terminated-thread enforcement.

### Scope

- Wire `invokeTool` into hook `ThreadState` scopes (`step.ts`, `thread-state.ts`, `tools.ts`), resolving in the hook's namespace with no `uses` limit and propagating `call.depth` into nested writes.
- Add `RunStore.claimDirect` and `RunStore.consumeQueued`, plus migration `0009_queue_agent.ts` allowing `kind = 'agent'` in `queue` (rebuilding `queue` table or relaxing the `CHECK` constraint cleanly in SQLite).
- Implement `invokeTool` on a handle at rest in `ThreadSupervisor.ts` and `trigger.ts` (`recoverLost`, `claimDirect`, minimal `Execution` with `promptPath: []`, `direct_tool` idle settlement, `ThreadBusy` on running thread, `ThreadTerminated` on terminated thread, watermark wakeup for work admitted during the run, abort and terminate handling).
- Implement `runAgent(agentName)` in `ThreadSupervisor.ts`, `thread-state.ts`, and `drain.ts` (durable `{ kind: "agent", agentName }` admission, `ThreadTerminated` refusal, FIFO queue serialization, `consumeQueued`, run-scoped agent override on `TurnController`).
- Update `DIVERGENCES.md` for `runAgent` (package-only), `invokeTool` at rest, and `direct_tool`.

### Modules it may touch

- `packages/runtime/src/execution/ThreadSupervisor.ts`
- `packages/runtime/src/execution/Execution.ts`
- `packages/runtime/src/execution/thread-state.ts`
- `packages/runtime/src/execution/tools.ts`
- `packages/runtime/src/execution/hooks.ts`
- `packages/runtime/src/execution/messages.ts`
- `packages/runtime/src/execution/step.ts`
- `packages/runtime/src/execution/drain.ts`
- `packages/runtime/src/execution/trigger.ts`
- `packages/runtime/src/store/migrations/0009_queue_agent.ts` (new), `sqlite.ts`, `model.ts`, `schema.ts`, `RunStore.ts`
- `packages/conformance/DIVERGENCES.md`, `ledger.json`, and scenario/test files

### Shared state it may change

- `queue` table `CHECK` constraint (migration `0009_queue_agent.ts`) and `QueueEntry` union (`kind: "agent"`).
- `ThreadSupervisor` `live` and `flows` maps (tracking direct `invokeTool` executions alongside normal runs).
- `Execution` minimal-execution mode and queue watermark wakeup.

### Ledger IDs closed

- M2a IDs (4). `specification:threads:39260b1a`, `specification:threads:a1ac0a36`, `specification:threads:9090af10`, `infrastructure:runtime:dc7d7df0`.

### Tests written first (Gemini 4 Neon)

- [ ] Conformance scenarios (`packages/conformance/src/scenarios/direct-execution.ts`, new) covering `invokeTool` from prompt hooks, delivery hooks, and at-rest hooks (`after_thread_created`, at-rest `before_create_message`), `NestedWriteTooDeep` when a `before_create_message` hook bounces through `invokeTool` into `injectMessage`, `invokeTool` at rest setting `running` and settling `idle` (`direct_tool`), `ThreadBusy` for a second concurrent `invokeTool` caller or while an agent run holds the thread, watermark wake starting a follow-up run for work admitted during `invokeTool` while leaving pre-existing parked work untouched, `runAgent` at rest and while running (verifying FIFO serialization and unchanged `threads.agent_id`), and `ThreadTerminated` rejection on terminated threads for both `invokeTool` and `runAgent` (covering handles created both before and after termination).
- [ ] Lifetime and crash-recovery tests (`packages/runtime/test/execution/ownership.test.ts`, `packages/runtime/test/cli/ownership.test.ts`) covering abort hold, terminate displacement, and process death (`SIGKILL` -> `execution_lost` without replay) during both `invokeTool` at rest and `runAgent`.

### Review depth and completion

- [ ] Thirty-minute Gemini 4 Neon reading review of `claimDirect`, `ThreadBusy`, watermark wakeups, `consumeQueued`, handle lifetimes, and abort/terminate/crash cleanup, plus a behavior audit against §2 and §3 of `docs/design/sides-and-turns.md`.
- [ ] `pnpm check`, `bun --bun run check`, and `pnpm fallow` pass.

---

## Found while reading, to add to the ledger

These normative statements appear in the 0.2.0 spec pages without an RFC 2119 keyword (or were missed during earlier curation) and belong in `packages/conformance/requirements.extra.json` and `ledger.json` as each PR lands.

| Spec location | Statement | Target PR |
|---|---|---|
| `specification/threads/execution-state.md` §3 (lines 60-61) | `state.execution.forceTurn('b')` forces the next turn to a specific side. | `M2a-1` |
| `specification/agents.md` §9.2 (line 223) | Two models converse, and each side sees itself as `assistant` and the other as `user`. | `M2a-1` |
| `specification/threads/execution-state.md` §2.3 (line 55) | During a handler-backed side's turn, `execution` is present and `currentSide` reflects that side, `stepCount` and per-side step counts advance only with model steps (contributing zero steps), and the turn still counts toward `maxSessionTurns`. | `M2a-2` |
| `specification/handlers.md` §1 (line 28) | The `message` parameter passed to a handler is the full persisted `Message` (id, role, content, silent flag, metadata, timestamps), not a narrowed view. | `M2a-2` |
| `specification/handlers.md` §3 (lines 46-52) | A handler-backed side's turn invokes the handler once with `ThreadState` and the inbound message, with no steps, no tool-choice loop, and no model requests. | `M2a-2` |
| `specification/handlers.md` §5 (line 74) | When a handler throws, the inbound message stays persisted and nothing is rolled back. | `M2a-2` |
| `specification/handlers.md` §5 (line 75) | When a handler throws, the session continues without ending the session, terminating the thread, or poisoning the queue, and the next inbound message gets a fresh handler invocation. | `M2a-2` |
| `specification/handlers.md` §6 (line 81) | A handler receives the full `ThreadState` and may respond with `injectMessage`, read and write KV, resolve env, and call tools. | `M2a-2` |
| `infrastructure/runtime.md` §3 (line 52) | For a handler-backed side, a turn is a single handler invocation with no context assembly, no model call, and no step loop, delivered once in order per thread. | `M2a-2` |

---

## Close the program

- [ ] Every M2a ledger statement (all 20 listed in `docs/design/sides-and-turns.md`) is `covered` on `main`.
- [ ] The five M1 partial statements closed by M2a are `covered`, and the three advanced partial statements name only M2b or M5 in their reasons.
- [ ] All nine statements in "Found while reading, to add to the ledger" are curated in `requirements.extra.json`, refreshed in `requirements.json`, and `covered` in `ledger.json`.
- [ ] `packages/conformance/DIVERGENCES.md` records `runAgent`, updated `invokeTool` at rest, handler-side queued tools, and runtime reason codes `direct_tool`, `max_total_turns`, and `handler_error`.
- [ ] `docs/plans/milestones.md` records what M2a cost and updates its M2a status.

## Not in M2a

- Prompt tools, agent handoff tools, and `sessionStop` / `sessionFail` / `sessionStatus` bindings (`M2b`).
- Typed thread environment values (`setEnv`) and validated thread arguments in prompt interpolation (`M2b`).
- Parent-child subagent spawning, `notifyParent`, and `setStatus` propagation (`M3b`).
- Thread endpoints and HTTP server (`M4`).
