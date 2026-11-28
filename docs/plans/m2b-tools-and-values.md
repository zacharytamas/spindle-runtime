# Tools between sides and thread values (M2b)

Written on 2026-11-27, from `main` at `a98fb70`. The scope comes from `docs/plans/milestones.md`, and the design rules come from `docs/design/secrets.md` and operator decisions 1, 2, 3, 4, and 6.

M2b closes when all 24 M2b ledger statements are settled (`covered`, or `deferred` where `docs/design/secrets.md` documents an intentional M2b limit) and every M1 partial statement that names M2b has been updated to reflect M2b's work.

## How to read this

- A box is checked only when the thing it names is true on `main`.
- The seven rules of `docs/plans/milestones.md` apply. The ones that shape this plan are short stacks, tests before the build, structure bar in every brief, and review depth by risk.
- M2b-1, M2b-2, and M2b-3 do not depend on M2a's side model. M2b-4 depends on it (`docs/design/sides-and-turns.md`). All four sit above M2a in the milestone 2 stack.

## Program checklist

### Order and limits

- [ ] At most three pull requests are open at a time, each based on the one below it. The operator lands them, bottom first. M2b comes after M2a, so the order is the two design pull requests, `M2a-1` to `M2a-3`, then `M2b-1` to `M2b-4`.
- [ ] Each M2b pull request is based on the open branch below it, or on `main` once that has landed. It starts when a slot is free and the branch below it is green and read. A fix to a lower branch is rebased into every branch above it, bottom first, one push at a time.
- [ ] `M2b-1` to `M2b-3` do not use M2a's side model, even though they come after it. `M2b-4` does.
- [ ] Only M2b-1 adds a SQLite migration. Before writing the migration file, the builder checks `packages/runtime/src/store/migrations/` on `main` and takes the next sequential migration number after M2a's migrations, `0007` to `0009`.
- [ ] A pull request that lands after another is rebased onto `main` by its owner or by the root. `ledger.json`, `DIVERGENCES.md`, and `thread-state.ts` are the shared merge points.

### Roles

- [ ] GPT-6.2 Astra builds. Gemini 4 Neon writes the tests that come before a build, and reads what the risk of a change calls for.
- [ ] For every pull request (M2b-1 through M2b-4), a Gemini 4 Neon writer commits failing tests first, from `docs/design/secrets.md`, the spec text, and (for M2b-4) `docs/design/sides-and-turns.md`. The GPT-6.2 Astra builder implements until they pass, and records the reason in the pull request for any test it changes.
- [ ] Every brief names the modules the pull request may touch, the shared state it may change, and a function-size cap.
- [ ] Every brief carries the clean-room rule, the Effect v4 rule, the rule against Grok models, the light-check rule, and the rule that no process is left behind.

### Checks, for every pull request

- [ ] One test file while iterating. The full `pnpm check` and `bun --bun run check` once at the end.
- [ ] `pnpm fallow` reports no issue.
- [ ] A pull request that adds a curated statement to `requirements.extra.json` refreshes `requirements.json` with `node scripts/spec-requirements.mjs --refresh` in the same commit, because `pnpm requirements` and the ledger check both read it.
- [ ] The ledger line changes only by the statements the pull request names (plus any curated statements from `docs/design/secrets.md` section 7 added to `requirements.extra.json`).
- [ ] Bot threads are read against the head, answered, and resolved before the root reports the pull request ready.

## Typed thread values, `setEnv`, and redaction floor (M2b-1)

**Dependency.** None on M2a's side model. Based on the `M2a-3` branch, or `main` once that has landed.

**Review depth.** High risk (security boundary and schema migration). Failing tests written first by Gemini 4 Neon, followed by a 30-minute Gemini 4 Neon reading review after the GPT-6.2 Astra build.

**Modules it may touch.** `packages/runtime/src/store/migrations/` (one new `thread_env` migration), `packages/runtime/src/store/sqlite.ts`, `packages/runtime/src/store/ThreadStore.ts`, `packages/runtime/src/store/model.ts`, `packages/runtime/src/store/schema.ts`, `packages/runtime/src/execution/env.ts`, `packages/runtime/src/execution/redact.ts`, `packages/runtime/src/execution/thread-state.ts`, `packages/runtime/src/execution/step.ts`, `packages/runtime/src/execution/tools.ts`, `packages/runtime/src/execution/trigger.ts`, `packages/runtime/src/providers/config.ts`, `packages/conformance/DIVERGENCES.md`, `packages/conformance/requirements.extra.json`, `packages/conformance/requirements.json`, `packages/conformance/ledger.json`, and tests.

**Shared state it may change.** New SQLite table `thread_env`, and the in-memory `Secrets` set of executions and at-rest handles.

**M2b ledger IDs closed (5).** `specification:threads:4495359b`, `specification:threads:6a7a34b7`, `specification:threads:4e919532` (settled `partial`, propagation to descendants owed by M3b), `specification:threads:274ed7a7` (settled `deferred`), `specification:tools:462ec47b` (settled `deferred`). Also upgrades M1 partials `specification:threads:287f2aef` and `specification:threads:a01f5667` to `covered`, and advances `specification:threads:341727f4`.

- [ ] Gemini 4 Neon commits failing tests first covering the numbered rules in `docs/design/secrets.md` section 1.4 except rules 9 to 11, which M3b owes, including type defaults, preservation on overwrite, rotation retention, `instanceEnv` isolation from `thread_env`, declared-vs-stored type disagreements, nested-only tool secret declarations, untyped provider env sources, and the 8-code-point non-whitespace redaction floor.
- [ ] Add SQLite migration for `thread_env` (`thread_id`, `name`, `value`, `type CHECK (type IN ('text', 'secret'))`, `PRIMARY KEY (thread_id, name)` `STRICT, WITHOUT ROWID`) and fenced `ThreadStore` reads and writes.
- [ ] Implement `ThreadState.setEnv`, update `env` precedence to read `thread_env` first, and update `envType` to return the effective thread classification and `'secret'` for non-thread and unknown names.
- [ ] Update `learnSecrets` to load all `thread_env` rows at start, register secret declarations on nested-only tools when entered, and mark untyped provider env sources as secret.
- [ ] Enforce the 8-code-point non-whitespace floor in `redact.ts` while keeping `{ type: 'env' }` secret-variable refusal unconditional at every length. Update `redact.test.ts`, `S26b`, `S26c`, and `S26h`.
- [ ] Record the plain-text-at-rest rule, the 8-code-point floor, and the `envType` vs declared-text-default reading in `DIVERGENCES.md`.
- [ ] Gemini 4 Neon completes a 30-minute reading review verifying secret isolation and write fencing.

## Final assembly check, thread arguments, locked parentage, and inherited deadlines (M2b-2)

**Dependency.** Depends on M2b-1. None on M2a.

**Review depth.** High risk (model-request security boundary, tool-group integrity, and callback lifetimes). Failing tests written first by Gemini 4 Neon, followed by a 30-minute Gemini 4 Neon reading review after the GPT-6.2 Astra build.

**Modules it may touch.** `packages/runtime/src/execution/assemble.ts`, `packages/runtime/src/execution/callback.ts`, `packages/runtime/src/execution/hooks.ts`, `packages/runtime/src/execution/messages.ts`, `packages/runtime/src/execution/tools.ts`, `packages/runtime/src/execution/thread-state.ts`, `packages/runtime/src/execution/trigger.ts`, `packages/runtime/src/execution/step.ts`, `packages/conformance/DIVERGENCES.md`, `packages/conformance/ledger.json`, and tests.

**Shared state it may change.** Validated `threads.arguments` written at `createThread` and exposed deep-frozen on `ThreadState.arguments`. No SQLite migration.

**M2b ledger IDs closed (2).** `specification:threads:e1c56064`, `specification:prompts:61b7d2b3`. Also upgrades M1 partial `specification:prompts:d263e879` to `covered` and advances `specification:threads:e6e64d26`.

- [ ] Gemini 4 Neon commits failing tests first covering all numbered rules in `docs/design/secrets.md` sections 2.1, 3.5, 4, and 5.3, plus every failure mode in section 6 that does not require prompt tools or handoffs.
- [ ] Consolidate request checking into one final check at the end of `assembleRequest` after `after_system_message`, `filter_messages`, and `prefilter_llm_history`, and before `observe({ type: "request" })` and provider dispatch.
- [ ] Redact eligible secrets in all four roles (`system`, `user`, `assistant`, `tool`) on the outgoing `ProviderRequest` without altering SQLite storage, preserving call and tool identifiers. Update `S26d`, `S26e`, `S26f`, and `I6` to match operator decision 2.
- [ ] Refuse any request with an incomplete, orphaned, split, mismatched, or duplicate tool group before dispatch, settling `failed` (`fatal_error`) on a top-level prompt with a redacted diagnostic naming the defect.
- [ ] Accept and validate optional `arguments` in `createThread`, deep-freeze `ThreadState.arguments`, validate arguments against `requiredSchema` before `{ type: 'env', property }` interpolation (including in included prompts), and sanitize control and Unicode BiDi characters.
- [ ] Lock `parent_id` and `depth` in `acceptMessage` (`hooks.ts`), remove `"parent_id"` from `TEXT_FIELDS`, and strip extra properties from stored `AttachmentRef` objects in `storedResult` and again at the final write boundary after every `before_create_message` hook, including injected messages. Tests cover a hook that adds a property holding a known secret, a secret placed in a content part's `mediaType` by `prefilter_llm_history`, and a secret first learned by `filter_messages` that matches an argument only after sanitization.
- [ ] Move hook and tool deadlines onto `Clock.monotonicTimeNanos` and propagate `min(parentDeadline, ownDeadline)` through nested hooks, write hooks, and `invokeTool`, checking deadlines after synchronous validation and keeping write count unbounded.
- [ ] Record the decision 2, 3, and 4 tensions and `{ type: 'env' }` argument interpolation in `DIVERGENCES.md`.
- [ ] Gemini 4 Neon completes a 30-minute reading review verifying no secret leaks across roles, no broken tool group reaches a provider, no create hook mutates `parent_id` or `depth`, and no nested callback escapes its parent's deadline.

## Prompt tools and `requiredSchema` (M2b-3)

**Dependency.** Depends on M2b-2. None on M2a.

**Review depth.** High risk (nested execution loop, shared step cap and secrets, scoped history, and message parentage). Failing tests written first by Gemini 4 Neon, followed by a 30-minute Gemini 4 Neon reading review after the GPT-6.2 Astra build.

**Modules it may touch.** `packages/runtime/src/execution/prompt-tool.ts` (new), `packages/runtime/src/execution/turn.ts`, `packages/runtime/src/execution/tools.ts`, `packages/runtime/src/execution/tool-lifecycle.ts`, `packages/runtime/src/execution/assemble.ts`, `packages/runtime/src/execution/drain.ts`, `packages/runtime/src/execution/step.ts`, `packages/runtime/src/execution/thread-state.ts`, `packages/conformance/DIVERGENCES.md`, `packages/conformance/requirements.extra.json`, `packages/conformance/requirements.json`, `packages/conformance/ledger.json`, and tests.

**Shared state it may change.** Persisted `messages` rows with `parent_id` and `depth > 0`, and shared execution `Secrets`, step counter, and callback tracking. No SQLite migration.

**M2b ledger IDs closed (7).** `infrastructure:runtime:0496b9da`, `specification:prompts:23ec065b`, `specification:prompts:bf53f925`, `specification:prompts:949d0585`, `specification:prompts:64c83f9a`, `specification:prompts:551cdfc5`, `specification:prompts:8ccbefff`. Also upgrades M1 partials `specification:threads/messages:e9cab494` and `specification:threads/messages:e551bf33` to `covered`.

- [ ] Gemini 4 Neon commits failing tests first covering prompt tools offered in `prompt.tools`, direct `invokeTool` and `queueTool` targeting a prompt (with and without `uses`), `requiredSchema` JSON Schema generation with `.describe()`, schema validation failures, `parent_id`, `depth`, `promptPath`, `SubpromptConfig` (`includeTextResponse`, `includeToolCalls`, `includeErrors`, `initUserMessageProperty`, `initAttachmentsProperty` with single path and array), `includeChat` scoping, nested final-check refusal returning an error `ToolResult`, nested secret sharing, inherited deadline aborting an inner model call, and `MaxPromptDepth` recursion cap.
- [ ] A prompt invoked through `invokeTool` from a hook or on a handle at rest has no stored caller message to be its `parent_id` (`docs/design/sides-and-turns.md` rules 40 and 47). M2b refuses that call with an error `ToolResult` that names the limit, records it in `DIVERGENCES.md`, and adds it to the follow-up list. A prompt invoked from a calling tool, offered to the model, or queued with `queueTool` has a stored caller and runs. Tests cover the refusal.
- [ ] Extend `exposedTools`, `invokeTool`, and `queueTool` to resolve prompt definitions alongside function tools, generating JSON Schema from `requiredSchema` with `.describe()` descriptions and validating arguments before execution.
- [ ] Implement nested prompt execution in `execution/prompt-tool.ts` with runtime-owned `parent_id` (final persisted caller ID), `depth` (`outerDepth + 1`), `promptPath`, `MaxPromptDepth` (default 8), shared `Secrets` (calling `learnSecrets` for the sub-prompt), shared `stepCap` and `abortSignal`, and inherited deadline.
- [ ] Map `initUserMessageProperty` and `initAttachmentsProperty` into the nested prompt's initial user message, reusing existing thread `AttachmentRef` metadata or synthesizing a path reference until M3a adds the thread filesystem.
- [ ] Serialize sub-prompt output into one text string honoring `includeTextResponse`, `includeToolCalls`, and `includeErrors`, and route inner failures to an error `ToolResult` on the outer call without crashing the outer execution.
- [ ] Document `MaxPromptDepth` and the pre-M3a `initAttachmentsProperty` reference fallback in `DIVERGENCES.md`. Add `specification/threads/execution-state.md:38` and `specification/prompts.md:129`, `158`, `159`, `160`, `161` to `requirements.extra.json` and cover them in `ledger.json`.
- [ ] Gemini 4 Neon completes a 30-minute reading review verifying nested message isolation, open-caller delete protection, deadline abort cleanup, and outer loop resilience.

## Handoff tools and session tools (M2b-4)

**Dependency.** **Depends on M2a (`docs/design/sides-and-turns.md` and M2a's landed side model on `main`)** and on M2b-3. Handoff tools switch the thread's agent and replace the active side value inside M2a's step loop, targeting either a prompt-backed or handler-backed non-human side. Session tools distinguish ending a single side's turn from ending a two-sided session.

**Review depth.** High risk (mutates thread agent ownership mid-execution and crosses M2a's side-switching boundary). Failing tests written first by Gemini 4 Neon, followed by a 30-minute Gemini 4 Neon reading review after the GPT-6.2 Astra build.

**Modules it may touch.** `packages/runtime/src/store/ThreadStore.ts` (fenced `setAgent`), `packages/runtime/src/execution/stop-rules.ts`, `packages/runtime/src/execution/response.ts`, `packages/runtime/src/execution/turn.ts`, `packages/runtime/src/execution/tools.ts`, `packages/runtime/src/execution/tool-lifecycle.ts`, `packages/runtime/src/execution/drain.ts`, `packages/runtime/src/execution/step.ts`, `packages/runtime/src/execution/Execution.ts`, `packages/runtime/src/execution/thread-state.ts`, `packages/runtime/src/registry/check-definition.ts`, `packages/conformance/DIVERGENCES.md`, `packages/conformance/requirements.extra.json`, `packages/conformance/requirements.json`, `packages/conformance/ledger.json`, and tests.

**Shared state it may change.** Persisted `threads.agent_id` (and validated handoff `threads.arguments`), active side value in M2a's step loop, and `Execution` session-stop state. No SQLite migration.

**M2b ledger IDs closed (10).** `infrastructure:runtime:fc8c359f`, `infrastructure:runtime:022219f5`, `specification:agents:8fb03a6e`, `specification:agents:cda6e847`, `specification:agents:2f2416ed`, `specification:agents:6e269b7f`, `specification:agents:e7466e70`, `specification:agents:050c4e51`, `specification:agents:5585bfa6`, `specification:agents:a9937a20`. Also upgrades M1 partials `specification:prompts:59cc8ad5`, `specification:tools:dc9a10a7`, `specification:tools:a403d2a5`, `specification:threads/execution-state:7a032a6c`, `infrastructure:runtime:d80e4c71`, and `infrastructure:runtime:7b5d1f06` to `covered`, and advances `specification:threads/execution-state:1a0354bc`, `specification:threads/execution-state:7029c151`, and `specification:threads:6a8e34ca`.

- [ ] Gemini 4 Neon commits failing tests first covering exposed agent handoffs from `prompt.tools`, manual handoffs via `queueTool` and `invokeTool` (with `uses` enforcement), rejecting agents without `exposeAsTool: true` or without a matching human side, durable `threads.agent_id` transfer preserving history, `promptPath` reset after handoff, `initUserMessageProperty` and `initAttachmentsProperty` on handoff, handoff to a handler-backed target agent via M2a's side model, sibling calls closed cleanly after handoff, `sessionStop` and `sessionFail` stop precedence ahead of `stopTool`/`stopOnResponse`/`maxSteps`/`maxSessionTurns`, `messageProperty` extraction with redaction, `sessionStatus` updating without ending the session, and `sessionStop` and `sessionFail` sharing the session-end path that M2a-2 builds for `state.stopSession()`.
- [ ] Add fenced `ThreadStore.setAgent` and wire handoff execution into `exposedTools`, `tools.ts`, `drain.ts`, and M2a's step loop so control transfers cleanly to the target agent's non-human side with fresh hooks, tools, `promptPath`, and `learnSecrets`.
- [ ] Enforce matching human-side conversational surface at setup, validation, and dynamic handoff invocation.
- [ ] Implement `sessionStop`, `sessionFail`, and `sessionStatus` bindings in `turn.ts`, `stop-rules.ts`, `response.ts`, and `step.ts`, matching local or qualified tool names, validating package existence in `spindle validate`, extracting and redacting `messageProperty`, and placing `sessionStop`/`sessionFail` first in stop precedence.
- [ ] Reuse the session-end path of root-thread `ThreadState.stopSession()`, which M2a-2 builds because the Handlers page needs it. M2b-4 does not build `stopSession()` again.
- [ ] Add `specification/threads.md:27`, `specification/threads/execution-state.md:39`, and `specification/agents.md:119` to `requirements.extra.json` and cover them in `ledger.json`.
- [ ] Gemini 4 Neon completes a 30-minute reading review verifying fenced agent transfer, complete tool-call groups across handoff, session-vs-turn stop boundaries on two-sided agents, and non-termination of threads on session end.

## Close the program

- [ ] Every M2b ledger statement is out of `planned` (21 `covered`, 1 `partial` whose reason names M3b, and 2 `deferred` for at-rest encryption).
- [ ] Every M1 partial statement that names M2b has been upgraded to `covered` or updated with its remaining later milestone.
- [ ] `docs/plans/milestones.md` records what M2b cost, in pull requests and in days, against this plan's four.

## Not in M2b

- `setEnv` propagation to descendant threads and the `scoped` boundary (`specification/tools.md:63` and `64`), owed by M3b, because no child thread exists before it.

- At-rest encryption for `thread_env` (`specification:threads:274ed7a7`, `specification:tools:462ec47b`), deferred until an external key-management boundary exists.
- Real thread filesystem resolution for `initAttachmentsProperty` and cross-thread attachment copying for `attachmentsProperty` (`specification:agents:38b9d170`), owned by M3a and M3b.
- Child-to-parent completion delivery, parent registry updates, and `parentHooks` activation on handoff targets (`specification:agents:33001fe2`), owned by M3b.
- User-account environment values (`specification:threads:a12ed69e`), owned by the Users milestone.
- Untrusted client endpoints and streams (design question 5), owned by M4 and M5.
