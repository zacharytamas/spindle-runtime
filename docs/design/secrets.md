# Secrets, assembly checks, and deadlines in a Spindle turn

**Status.** Settled for M2b on 2026-11-27, based on `main` at commit `a98fb70`, Standard Agent Specification `0.2.0` at commit `f462a673297faed1f849ef1741ddda1e06b6c817`, and `@standardagents/spec` `0.45.13`. Operator decisions 1, 2, 3, 4, and 6 from `docs/plans/milestones.md` are final and govern this note. Question 5 remains open for M4.

**The rule.** Give a credential to the code and transport that need it. Classify every thread value as secret unless its definition says otherwise. Never interpolate a secret variable or an unvalidated thread argument into a system prompt. Check every outgoing model request once at the end of assembly, redacting eligible secrets in every role and refusing incomplete tool groups. Lock `parent_id` and `depth` as runtime-owned facts. Share one monotonic deadline across an operation and everything its hooks and nested tools start, with no cap on write count.

## 1. Data shape for typed thread values

Thread environment values live in a dedicated SQLite table named `thread_env`, separate from `kv`. Separating the table keeps `getValue` and `setValue` from reading or overwriting environment entries, attaches a type column to every key, and leaves room for encryption in a later milestone without touching `kv`.

```sql
CREATE TABLE thread_env (
  thread_id TEXT NOT NULL REFERENCES threads (id),
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'secret')),
  PRIMARY KEY (thread_id, name)
) STRICT, WITHOUT ROWID
```

The runtime shape of one typed thread value is `{ name: string, value: string, type: 'text' | 'secret' }`.

### 1.1 Storage at rest

Spindle keeps its milestone 1 storage rule for M2b. Thread environment rows are durable in SQLite and stored in plain text at rest.

Threads section 2.3 (`specification:threads:274ed7a7`) and Tools section 3 (`specification:tools:462ec47b`) state that environment values and `type: 'secret'` values should be encrypted at rest when the runtime supports encrypted storage. Both are `SHOULD` statements, not `MUST` statements. Spindle runs on one local SQLite file with no key-management service. Storing an encryption key beside the database would not protect the file on disk. Protecting the SQLite file remains the host's job until a later milestone adds an external key boundary. Both statements are to be recorded as documented limits in `DIVERGENCES.md` and settled as `deferred` during the M2b-1 build.

### 1.2 Sources, precedence, and classification

`env(propertyName)` resolves in strict order across the sources below. User-account values sit between prompt defaults and the runtime instance and arrive with the Users page.

| Precedence | Source | Value origin | `envType(name)` answer | Effective secret classification |
|---|---|---|---|---|
| 1 | Thread env (`thread_env`) | Written by `setEnv` | Stored `type`, upgraded to `'secret'` if any active declaration or provider config marks `name` secret | Secret unless stored `type` is `'text'` and nothing active marks `name` secret |
| 2 | Agent default (`agent.env`) | Agent definition | `'secret'` | Secret unless an active `VariableDefinition` declares `name` as `'text'` and nothing marks `name` secret |
| 3 | Tool-entry default (`PromptToolConfig.env`) | Prompt tool entry | `'secret'` | Secret unless an active `VariableDefinition` declares `name` as `'text'` and nothing marks `name` secret |
| 4 | Prompt default (`prompt.env`) | Prompt definition | `'secret'` | Secret unless an active `VariableDefinition` declares `name` as `'text'` and nothing marks `name` secret |
| 5 | Runtime instance (`Config`) | Operator environment | `'secret'` | Always secret |
| 6 | Provider config slot (`resolveConfig`) | Instance env or slot default | Not read through `envType` | Secret when slot `type` is `'secret'`, source `valueType` is `'secret'`, or an env source has no explicit non-secret type |
| 7 | Unknown name | Absent everywhere | `'secret'` | Unknown (`env` rejects and `instanceEnv` returns `undefined`) |

Threads section 2.3 and the doc comment on `ThreadState.envType` in `@standardagents/spec` `0.45.13` both state that unknown and non-thread sources default to `'secret'`. Answering `'secret'` from `envType` for all non-thread sources follows both texts literally, including at rest when no prompt is active. Keeping declared `'text'` definition defaults unredacted and eligible for `{ type: 'env' }` interpolation preserves milestone 1 scenario `S26` without forcing every static prompt default through `setEnv`. Removing declared `'text'` defaults from the secret set also eliminates milestone 1's split between `Secrets.values` and `Secrets.barred`, leaving one `Secrets.names` set and one `Secrets.values` set. This reading is to be recorded in `DIVERGENCES.md` during the build.

### 1.3 Minimum length for redaction

Spindle applies substring redaction only to secret strings that contain at least **8 Unicode code points** (`[...secret].length >= 8`) and at least one non-whitespace character (`secret.trim() !== ""`).

**Reason.** Following the spec default means `setEnv(name, value)` without `{ type: 'text' }` marks the value `'secret'`. Common state values, including `'open'` from Threads section 2.3, `'true'`, `'false'`, `'draft'`, `'closed'`, `'active'`, `'pending'`, `'staging'`, `'default'`, `'running'`, `'success'`, language tags, and port numbers, are 1 to 7 code points long. Under milestone 1's zero-floor rule and M2b's every-role request redaction, any such untyped value would shred ordinary prose, JSON payloads, and system prompts. Raising the floor to 12 or 16 would miss human-chosen 8-to-11-character passwords and short service tokens. Eight Unicode code points matches the NIST SP 800-63B minimum length for memorized secrets, skips every 1-to-7-character flag and status label, and still catches passwords, API keys, bearer tokens, signing secrets, and high-entropy credentials. Excluding whitespace-only strings prevents an 8-space indent from corrupting formatted JSON and code blocks. Using Unicode code points matches `isSafeId` in `packages/runtime/src/execution/hooks.ts`.

This floor changes milestone 1's no-floor rule. The updated limit is to be recorded in `DIVERGENCES.md`, and milestone 1 tests `redact.test.ts`, `S26b`, `S26c`, and `S26h` are updated in M2b-1.

### 1.4 Testable rules for typed thread values

1. `setEnv(propertyName, value, options?)` persists a row in `thread_env` that survives execution boundaries and process restarts.
2. Calling `setEnv` for a key not yet in `thread_env` with `options` or `options.type` omitted stores `type` as `'secret'`.
3. Calling `setEnv` for a key already in `thread_env` with `options` or `options.type` omitted preserves the key's existing `type`.
4. Calling `setEnv` with `{ type: 'text' }` or `{ type: 'secret' }` stores that exact `type`.
5. `setEnv` rejects with `InvalidArguments` if `propertyName` is not a non-empty string, if `value` is not a string, or if `options.type` is defined and neither `'text'` nor `'secret'`.
6. `setEnv` rejects with `KeyNotWellFormed` if `propertyName` contains a lone UTF-16 surrogate, leaving `thread_env` unchanged.
7. `setEnv` checks `WriteOrigin` inside its SQLite transaction and rejects with `FlowEnded`, `HandleExpired`, or `ThreadTerminated` when the handle or thread cannot write.
8. `setEnv` preserves NUL bytes in `value` on both Node and Bun drivers and normalizes lone UTF-16 surrogates in `value` to `U+FFFD`, matching stored message text.
9. Propagation to descendant threads is owed by M3b, because no child thread exists before it. In M2b, `setEnv` writes only the thread that owns the handle. M3b's note settles three rules from the spec. `setEnv` propagates to every active descendant in the same transaction. It skips a terminated descendant and does not descend through it. It stops at a descendant whose agent graph declares the name with `scoped: true`.
10. Moved to M3b with rule 9.
11. Moved to M3b with rule 9.
12. `env(propertyName)` checks `thread_env` first, then `agent.env`, then `PromptToolConfig.env` when applicable, then `prompt.env`, and finally the runtime instance environment.
13. `instanceEnv(propertyName)` reads only the runtime instance environment and ignores any value stored in `thread_env`, `agent.env`, `PromptToolConfig.env`, or `prompt.env`.
14. `envType(propertyName)` returns `'secret'` when `propertyName` is absent from `thread_env`, including when a definition default or the runtime instance supplies a value.
15. `envType(propertyName)` returns `'secret'` when `propertyName` is in `thread_env` with `type: 'text'` if any active prompt variable, exposed tool variable, nested tool variable, or provider config marks `propertyName` as `'secret'`.
16. `envType(propertyName)` returns `'text'` only when `propertyName` is in `thread_env` with `type: 'text'` and no active declaration or provider config marks `propertyName` as `'secret'`.
17. At execution start, at rest handle creation, and before CLI printing, `learnSecrets` loads every row of `thread_env` for that thread and registers every secret-classified value into the execution's `Secrets` set before step 1.
18. When `setEnv` writes a secret-classified value during an execution, that value enters the execution's `Secrets` set before `setEnv` resolves, and any previous secret value for that key remains in `Secrets` for the rest of that execution.
19. When a nested tool reachable only through `invokeTool` starts (M2b-1), or a nested prompt tool starts (M2b-3, which adds nested prompts), Spindle registers its `type: 'secret'` variable declarations and learns their values into the execution's `Secrets` set before user code runs.
20. A provider config env source that declares neither `valueType` nor a non-secret slot `type` registers its name and resolved string value as a secret.
21. Substring redaction replaces a secret value only when `[...secret].length >= 8` and `secret.trim() !== ""`, matching the literal string, its once-JSON-escaped spelling, and its spelling after the argument sanitization of section 2.1 rule 9, with longer secrets replaced first. Eligibility is measured on the secret as stored. The sanitized spelling is used only when it differs from the stored secret and itself meets the floor of section 1.3, so a secret that sanitizes to a short or empty string never becomes a search pattern. So a secret first learned by a request hook after an argument was sanitized is still caught in the final check.
22. Direct `{ type: 'env', property }` interpolation in `renderSystemPrompt` refuses any secret-classified or instance-sourced variable regardless of value length, even when the value has fewer than 8 code points.

## 2. Thread arguments and prompt interpolation

Standard Agent Specification `0.2.0` defines no inline placeholder syntax such as `{{name}}`. Spindle interpolates variables and validated top-level thread arguments through `@standardagents/spec`'s `{ type: 'env', property }` prompt part, inside both the rendering prompt and any prompt it includes. This reading is to be recorded in `DIVERGENCES.md` during the build.

### 2.1 Validation and sanitization rules

1. `createThread` accepts an optional `arguments` object, validates it against the agent's side A prompt `requiredSchema` when that prompt defines one, and persists the caller's original plain JSON object in `threads.arguments`, not the schema's parsed output. A schema with a `transform` therefore validates the same input at every render.
2. `ThreadState.arguments` returns a deep-frozen copy of the thread's original creation arguments (or the nested prompt's original invocation arguments inside a prompt tool) so user code cannot mutate it across calls or participants.
3. Before interpolating any thread or invocation argument key in `renderSystemPrompt`, Spindle validates the stored original argument object against the rendering prompt's `requiredSchema` with `safeParseAsync`, and interpolates from that parse's output. It never parses a parse's output again.
4. A prompt that defines no `requiredSchema` interpolates no thread or invocation argument key through `{ type: 'env', property }`.
5. If validation against `requiredSchema` fails during `renderSystemPrompt`, assembly fails with `SetupError` before any model request on a top-level prompt, or returns an error `ToolResult` on a nested prompt tool.
6. Only top-level own keys of the validated `requiredSchema` result are eligible as interpolated argument values, and they are available to both the root prompt and any prompt reached through `{ type: 'include' }`.
7. If an argument key shares its name with a variable marked `'secret'` by any active declaration or provider config, `renderSystemPrompt` refuses the interpolation even when the key is in `requiredSchema`, failing with `SetupError` on a top-level prompt or returning an error `ToolResult` on a nested prompt tool.
8. Non-string validated argument values are converted with `JSON.stringify`, and `undefined` optional fields fall through to declared text `env` lookup or interpolate as `""`.
9. Every interpolated argument string is sanitized before insertion by normalizing `\r\n` and `\r` to `\n` and stripping ASCII control characters (`U+0000` to `U+0008`, `U+000B`, `U+000C`, `U+000E` to `U+001F`, `U+007F`) and Unicode bidirectional override characters (`U+200E`, `U+200F`, `U+202A` to `U+202E`, `U+2066` to `U+2069`).
10. Redaction runs on each argument string before sanitization. Spindle replaces every known secret that meets the floor of section 1.3, measured on the secret as stored, with `[redacted]`, and only then applies rule 9. A secret such as `pass\u202Eword123` is therefore redacted before the bidirectional character is stripped, and cannot reach the prompt as `password123`.
11. A known secret inside a validated thread argument is also redacted from the rendered system prompt by the final check before dispatch.

## 3. The final check at the end of assembly

Operator decisions 2 and 4 replace milestone 1's split `checkSystemPrompt` and `checkSystemMessages` calls with one final check at the end of `assembleRequest`.

### 3.1 Position in assembly

Context assembly proceeds in this order for every top-level prompt and every nested prompt tool.

1. Interpolate the system prompt in `renderSystemPrompt`, enforcing required variables, schema validation for arguments, and direct refusal of secret or instance `{ type: 'env' }` lookups.
2. Run `after_system_message` hooks on the rendered system prompt.
3. Take a stable snapshot of eligible persisted history.
4. Run `filter_messages` hooks once on that snapshot.
5. Transform the filtered history into `ProviderMessage[]` in request order.
6. Run `prefilter_llm_history` hooks, convert returned `LLMMessage[]` back to `ProviderMessage[]`, and strip reasoning when `reasoning.include` is `false`.
7. Check `run.stopAtBoundary()`.
8. Build the complete `ProviderRequest` containing `[{ role: "system", content: system }, ...messages]`.
9. Run the **final check** once on `request`.
10. Emit `observe({ type: "request", request })` with the checked, redacted request and dispatch to the provider.

### 3.2 What the final check reads, redacts, and refuses

**What it reads.** The final check inspects every message in `request.messages` across all four roles (`system`, `user`, `assistant`, `tool`) and reads the execution's live `Secrets.values` set filtered by the 8-code-point non-whitespace floor. Because it runs after every request hook finishes, any secret learned during `after_system_message`, `filter_messages`, or `prefilter_llm_history` is included.

**What it redacts.** The final check returns a new `request.messages` array without mutating SQLite rows. It replaces eligible secrets with `[redacted]` in the fields below while preserving structural identifiers.

| Role | Redacted fields | Preserved identifiers and untouched binary fields |
|---|---|---|
| `system` | `content` | none |
| `user` | String `content`, or `text.text`, `image_url.image_url.url`, `file.filename`, the `mediaType` of image and file parts, and the header of a `data:` URI in `image.data` or `file.data` (the part before the first comma) in `ContentPart[]` | The encoded payload after the first comma of `image.data` and `file.data` |
| `assistant` | `content`, `reasoning`, `text` field of `text` and `summary` entries in `reasoningDetails`, and every string value and object key in `toolCalls[].arguments` and `toolCalls[].extraContent` | `toolCalls[].id`, `toolCalls[].name`, opaque `encrypted` entries in `reasoningDetails` |
| `tool` | String `content`, `{ type: "text", text }`, `{ type: "error", error }`, and the text, url, filename, `mediaType` and `data:` URI header fields of `ContentPart[]` | `toolCallId`, `toolName`, the encoded payload after the first comma of `image.data` and `file.data` |

Static tool definitions (`request.tools`) and `request.model` are not mutated, because rewriting JSON Schema property names or model identifiers would break provider calls. Developers must keep credentials in provider transport config slots, never in tool definitions or `providerOptions`.

**What it refuses.** After redaction (or before it, since tool call IDs are never redacted), the final check validates every tool-call and tool-result group across `request.messages` in order. A request is valid if and only if every `assistant` message with a non-empty `toolCalls` array is immediately followed by a contiguous run of `tool` messages that forms a one-to-one match with that `assistant` message's call IDs, with no duplicate call IDs in the `assistant` message, no empty call IDs, no duplicate `tool` results for the same call ID, no missing `tool` results, no intervening message of another role, and no orphan `tool` message anywhere outside a matching group.

### 3.3 What error reaches whom

When the final check refuses a request for a broken tool group, Spindle constructs a typed `SetupError` whose message names the specific pairing defect (unanswered call ID, orphan tool result, mismatched call ID, duplicate call ID, or duplicate tool result) and contains no secret value.

| Caller or sink | Top-level prompt | Nested prompt tool |
|---|---|---|
| Provider (`stream` / `generate`) | Never called | Never called |
| `observe({ type: "request" })` | Never called | Never called |
| Stored messages in SQLite | Unchanged | Unchanged |
| Execution outcome (`RunOutcome`) | Settles `failed` with reason `fatal_error` and redacted `error.message` | Outer execution continues. Inner prompt does not crash the outer loop |
| Outer tool call / `invokeTool` caller | Not applicable | Receives `{ status: "error", error }` with the redacted pairing diagnostic, persisted as the outer tool result |
| CLI stderr / library caller | Prints redacted `error.message` and exits non-zero | Sees the persisted outer tool error result |

### 3.4 Spec tensions to record in `DIVERGENCES.md`

Two tensions arise from operator decisions 2 and 4 and are to be recorded in `DIVERGENCES.md` during the M2b-2 build.

- Hooks section 3.3 (`specification:hooks:5cf7c4b6`) says the array `prefilter_llm_history` returns must be the provider request history. Under decision 2, Spindle redacts known secrets across every role in that returned array before sending it to the provider. This also supersedes milestone 1's documented behavior where `checkSystemPrompt` and `checkSystemMessages` failed the run for a literal secret in a system message while letting non-system hook output pass raw (`S26d` case 2, `S26e` cases 2 and 3, `S26f`, and `I6` change accordingly).
- Hooks introduction (`specification/hooks.md:5`) says a hook's failures are non-fatal to the decorated turn. Under decision 4, a request in which `filter_messages` or `prefilter_llm_history` leaves an incomplete tool group is refused before dispatch rather than sent to fail upstream or silently reverted.

### 3.5 Testable rules for the final check

1. The final check runs exactly once per model request, after `after_system_message`, `filter_messages`, and `prefilter_llm_history` have all returned and before `observe({ type: "request" })` and provider dispatch.
2. The final check runs identically for top-level prompts and nested prompt tools.
3. A known secret of at least 8 non-whitespace code points placed by a request hook into a `system`, `user`, `assistant`, or `tool` message is replaced with `[redacted]` in the dispatched `ProviderRequest`.
4. A known secret of at least 8 non-whitespace code points learned by `filter_messages` or `prefilter_llm_history` is redacted from the leading `system` prompt as well as from history messages in that same assembly.
5. Canonical human and model messages stored in SQLite keep their original text, while the outgoing `ProviderRequest` redacts eligible secrets from replayed human content, model content, reasoning, tool-call arguments, and extra content.
6. The final check never mutates `toolCalls[].id`, `toolCalls[].name`, `toolCallId`, or `toolName`.
7. The result group of an `assistant` message with `toolCalls` is the run of contiguous `tool` messages directly after it. A request in which a call has no result in its group is refused before dispatch.
8. A request containing a `tool` message that is not in the result group of an `assistant` message listing its `toolCallId` is refused before dispatch. `assistant(calls A, B), tool(A), tool(B)` is valid.
9. A request in which a message of another role ends a result group before every call of its `assistant` message has a result is refused before dispatch.
10. A request containing duplicate call IDs in one `assistant` message or duplicate `tool` messages for one `toolCallId` in one group is refused before dispatch.
11. A request whose `tool` messages appear in a different order within the contiguous group directly after their `assistant` message, with a valid one-to-one match of call IDs, is accepted.
12. When the final check refuses a top-level prompt request, the provider is not called, no `request` observation fires, stored messages do not change, and the execution settles `failed` with reason `fatal_error` and a diagnostic naming the pairing defect.
13. When the final check refuses a nested prompt tool request, the inner provider is not called, the outer execution does not fail, and the outer tool call receives an error `ToolResult` carrying the redacted pairing diagnostic.

## 4. Runtime-owned `parent_id` and `depth`

Operator decision 3 makes `parent_id` and `depth` runtime-owned facts alongside `flow_id` and `caller_seq`.

1. `acceptMessage` in `packages/runtime/src/execution/hooks.ts` rejects any `before_create_message` return whose `parent_id` (defaulting to `current.parent_id` when omitted) differs from `current.parent_id`.
2. `acceptMessage` rejects any `before_create_message` return whose `depth` (defaulting to `current.depth` when omitted) differs from `current.depth`.
3. On an essential write (inbound message, model response, tool result, or nested prompt message), a create hook that attempts to alter `parent_id` or `depth` logs a warning and Spindle keeps the prior draft.
4. On `injectMessage`, a create hook that attempts to alter `parent_id` or `depth` fails with `HookFailed` and vetoes the injection.
5. `"parent_id"` is removed from the hook-redacted `TEXT_FIELDS` list because user code can never write it.
6. Deleting a message with tool calls keeps the existing `caller_seq` cascade and does not recursively delete nested sub-prompt messages whose `parent_id` points to that caller.

This extends Spindle's existing divergence from Hooks section 4.1 (`specification/hooks.md:321`, which says the returned object must be used for insertion) and is to be recorded in `DIVERGENCES.md` during the M2b-2 build.

## 5. Inherited deadline

Operator decision 6 gives one originating operation and everything its hooks and nested tools start a single shared time budget, with no cap on total writes.

### 5.1 Clock and representation

Deadlines use the Effect v4 `Clock` service's monotonic clock (`Clock.monotonicTimeNanos` and `clock.monotonicTimeNanosUnsafe()`) for both hooks and tools, replacing milestone 1's wall-clock check for hooks in `packages/runtime/src/execution/callback.ts`. A wall-clock jump can never extend or prematurely expire a deadline.

Every callback boundary carries an optional absolute monotonic deadline `deadlineNanos: bigint | undefined`. When a child operation starts with parent deadline `parentDeadline` and its own configured limit `ownLimit: Duration.Duration | undefined` (`HookTimeout` for a hook, `toolTimeout(qualifiedName)` for a tool, or `undefined` when unbounded), Spindle computes `ownDeadline` from `Clock.monotonicTimeNanos` plus `Duration.toNanosUnsafe(ownLimit)` (when `Duration.isFinite(ownLimit)` is true) and sets the child's effective deadline to the earlier of `parentDeadline` and `ownDeadline`.

```text
effectiveDeadline = min(parentDeadline, ownDeadline)
```

If `effectiveDeadline` is already at or before the current monotonic time, the child times out immediately without entering user code. Otherwise `Callback.within` sleeps for `Duration.nanos(effectiveDeadline - now)` through `clock.sleep` and checks `clock.monotonicTimeNanosUnsafe() > effectiveDeadline` both on completion and after synchronous return validation.

### 5.2 Propagation paths

| Parent operation | Child operation | Effective deadline | When parent deadline is shorter than child's own limit |
|---|---|---|---|
| Hook (`HookTimeout` 30s) | Nested write's hook (`HookTimeout` 30s) | `parentDeadline` (remaining time of outer hook) | Nested hook expires at `parentDeadline`. Late return is discarded and handle expires with `HookExpired` |
| Hook (`HookTimeout` 30s) | Nested `invokeTool` (unbounded or `--tool-timeout` 60s) | `parentDeadline` (remaining time of outer hook) | Nested tool cannot outlive the hook. Expires at `parentDeadline` with `HandleExpired` |
| Hook (`HookTimeout` 30s) | Nested `invokeTool` (`--tool-timeout` 5s, 20s left) | `now + 5s` (child's own shorter limit) | Child tool times out at 5s and returns a timeout error `ToolResult`. Parent hook keeps its remaining 15s |
| Tool (`--tool-timeout` 10s) | Write hook (`HookTimeout` 30s) or nested `invokeTool` | `min(parentDeadline, ownDeadline)` | Child hook or tool gets only the parent tool's remaining time |
| Tool (no `--tool-timeout`) | Write hook (`HookTimeout` 30s) | `now + 30s` | Hook starts a 30s budget. Anything that hook starts inherits that 30s deadline |
| Model call or tool | Prompt tool (`--tool-timeout` or inherited parent deadline) | `min(parentDeadline, ownDeadline)` | Every inner hook, inner model call (via child `AbortController`), and inner tool inherits the effective deadline |
| Any hook or tool | `queueMessage` or `queueTool` | Enqueue itself runs under caller deadline. Later execution does not inherit it | Queued work executes in a later step with its own fresh budgets |

### 5.3 Testable rules for the inherited deadline

1. Both hooks and tools measure deadlines against `Clock.monotonicTimeNanos`, so shifting the wall clock does not change when a hook or tool expires.
2. A hook started by a write made inside an outer hook inherits `min(parentDeadline, now + HookTimeout)` and never receives a fresh full `HookTimeout` beyond its parent's deadline.
3. A nested tool invoked via `state.invokeTool` from a hook or from a bounded tool inherits `min(parentDeadline, ownToolDeadline)`, even when the nested tool has no `--tool-timeout` of its own.
4. When a child tool or hook has a shorter own limit than the parent's remaining time, the child times out at its own limit and returns its timeout outcome to the parent while the parent continues within its remaining budget.
5. When a parent's deadline has already elapsed before a nested hook or tool starts, Spindle refuses to enter the child user code and treats the child as immediately timed out.
6. When an inherited deadline expires during a nested prompt tool, Spindle aborts the inner model request's signal, expires active inner handles, and returns a timeout error `ToolResult` to the outer caller without crashing the outer execution.
7. Synchronous return validation and result reading check the deadline again after reading getters, so a slow getter that pushes past the deadline fails the callback as timed out.
8. Writes have no count budget. A hook may perform any number of sequential writes that fit within its inherited deadline and within `NestedWriteLimit` (depth 8).
9. Work admitted through `queueMessage` or `queueTool` does not inherit the enqueuing hook's or tool's deadline when drained in a later step.

## 6. Failure modes

Every entry below states what can go wrong, what Spindle must do, and any documented boundary where runtime string matching cannot protect an authorized participant.

### 6.1 The model

1. **Secret split across two messages or transformed.** A model outputs the first half of a secret in one turn and the second half in the next turn, or encodes the secret in base64 or hex. Substring matching scans each message field independently for literal and once-JSON-escaped secrets of at least 8 non-whitespace code points, so split or encoded fragments are not matched. This is an explicit threat-model boundary. Never expose a credential to the model if confidentiality against model exfiltration is required.
2. **Secret in model-emitted tool arguments.** A model places a known secret (at least 8 non-whitespace code points) inside the JSON arguments of a tool call. Canonical SQLite storage keeps the assistant response as returned, and the tool receives its validated arguments. On every subsequent model request, the final check redacts string values and keys inside `assistant.toolCalls[].arguments` before dispatch, and CLI output redacts the printed `[tool call]` line.
3. **Malformed tool arguments or unoffered prompt or handoff tool.** A model sends non-object JSON arguments or calls an unknown, unoffered, or disallowed prompt or handoff tool. Spindle never executes the target, persists an error `ToolResult` bound to the call ID, and runs the next sibling call.
4. **Handoff alongside sibling tool calls.** A model emits a handoff call followed by another tool call in the same response. Spindle runs calls in order, commits the handoff and its result, closes every remaining unexecuted sibling call from the old agent with a protected error result so tool groups stay complete, and transfers control to the target agent's active side.
5. **Empty response or `toolChoice` violation inside a nested prompt tool.** The inner `callModel` retries up to the configured retry limit. If still rejected, the nested prompt returns an error `ToolResult` to the outer call without failing the outer execution.

### 6.2 The network and providers

1. **Provider error or metadata echoes a secret.** An upstream HTTP error body, provider exception message, `upstream` field, `metadataError`, or plain `metadata` object contains a known secret (at least 8 non-whitespace code points). Spindle redacts all of them before returning `RunOutcome` or printing to stderr. Non-plain or cyclic provider metadata is dropped to `null` rather than passed through unwalked.
2. **Provider stream stalls past an inherited deadline.** An inner model call inside a prompt tool stalls past the prompt tool's deadline. Spindle aborts the inner request's `AbortSignal`, closes any streamed unexecuted calls with `tool_call_done` error observations, and returns a timeout error `ToolResult` to the outer call.
3. **Provider stream truncates without `finish`.** The attempt fails with retryable `server_error`, persists no message, and executes no tool call from the incomplete stream.

### 6.3 User code in hooks

1. **Request hook injects a secret into any role.** `after_system_message`, `filter_messages`, or `prefilter_llm_history` introduces a known secret (at least 8 non-whitespace code points) into a `system`, `user`, `assistant`, or `tool` message, or learns a secret during history filtering that already appeared in the leading system prompt. The final check at the end of assembly redacts it in every role before `observe` and dispatch.
2. **Prefilter or filter hook leaves an incomplete tool group.** A hook drops a tool result while keeping its assistant call, drops a call holder while keeping its result, inserts a message between a call and its result, or duplicates a call ID or result. The final check refuses the request before `observe` and dispatch. A top-level prompt settles `failed` (`fatal_error`). A nested prompt tool returns an error `ToolResult`.
3. **Create hook tries to alter `parent_id` or `depth`.** `acceptMessage` rejects the return. An essential write keeps the prior draft and logs a warning. `injectMessage` fails with `HookFailed`.
4. **Create hook puts a known secret in a proposed message ID or a later hook learns that secret.** Both the per-hook check and the post-hook check refuse a secret-bearing custom ID (vetoing `injectMessage` or falling back to the generated UUID on essential writes).
5. **Hook triggers nested writes or tools that outlive its deadline.** Inherited deadlines expire the nested hooks and tools at the outer hook's deadline, discard late returns, reject later `ThreadState` calls with `HookExpired` or `HandleExpired`, and fail late commits inside SQLite via `origin.expired()`.
6. **Hook throws an error containing a secret or prints to native `console`.** Runtime hook warnings log only hook ID, position, and action, never thrown text or arguments. Native `console` calls from trusted in-process JavaScript bypass Spindle's redacting logger (explicit threat-model limit).

### 6.4 User code in function tools

1. **Tool returns a secret in output, error data, JSON keys, or attachment fields.** Write-time redaction replaces eligible secrets in `content`, `metadata` (keys and values, preserving top-level `error_code` and `error_data` keys and a tool result's own `error_code` value), and attachment `name` and `description`. `storedResult` keeps only the spec's `AttachmentRef` fields, closing milestone 1's extra-property escape route. The same whitelist runs again at the final write boundary, after every `before_create_message` hook and for injected messages too, so a hook cannot add a property back.
2. **Tool queues a secret in `queueTool` arguments.** `queueTool` validates plain JSON arguments and scans every key and string value for known secrets (at least 8 non-whitespace code points). If any matches, `queueTool` synchronously throws `SecretInArguments` without persisting to `queue` and without including the secret in the error message.
3. **Tool writes a secret with `setValue`.** Durable `kv` is unredacted general thread state. Trusted code must store credentials through `setEnv`, not `setValue`.
4. **Nested-only tool copies its own secret variable default.** Before executing any tool through `invokeTool`, Spindle registers that tool's `type: 'secret'` variable declarations and learns their values into the execution's `Secrets` set so its defaults are redacted on write and in the final check.

### 6.5 User code in prompt tools and thread arguments

1. **Secret in a thread argument used for interpolation.** A caller supplies a thread or prompt-tool argument containing a known secret (at least 8 non-whitespace code points), and the prompt interpolates that key under `requiredSchema`. `renderSystemPrompt` validates the argument against `requiredSchema` and sanitizes control and BiDi characters, and the final check redacts the secret to `[redacted]` in the system message before `observe` and dispatch. If the key name itself is marked `'secret'` by any declaration or provider config, `renderSystemPrompt` refuses the interpolation outright with `SetupError` (top-level) or an error `ToolResult` (nested).
2. **Unvalidated or schema-failing thread argument.** A prompt without `requiredSchema` tries to interpolate a thread argument, or stored/caller arguments violate `requiredSchema`. `renderSystemPrompt` refuses before any model request (`SetupError` on a top-level prompt, error `ToolResult` on a nested prompt or handoff).
3. **Recursive prompt tool loop.** Prompt A calls prompt A (directly or through prompt B). Once nesting depth exceeds `MaxPromptDepth` (default 8), Spindle refuses to enter the recursive prompt and returns an error `ToolResult`. Total model steps remain bounded by the outer execution's `stepCap`, and wall time by the inherited deadline.
4. **Secret learned inside a nested prompt leaks into its serialized result.** Because the nested prompt shares the outer execution's `Secrets` set and runs `learnSecrets` before its first step, any secret learned inside the nested prompt is redacted from the serialized outer tool result before storage and before the outer model's next request.

### 6.6 `setEnv` callers and type disagreements

1. **Declared type is `'secret'` while `setEnv` writes `{ type: 'text' }`.** The stricter classification wins. `envType` returns `'secret'`, the value enters `Secrets` and is redacted wherever eligible, and `{ type: 'env' }` system-prompt interpolation is refused. The `thread_env` row preserves `'text'` in SQLite so the stricter rule is enforced dynamically without destroying stored metadata.
2. **Declared type is `'text'` while `setEnv` passes `{ type: 'secret' }`, or omits `type` on a key that is not yet stored or is stored as `'secret'`.** Omitting `type` on a key stored as `'text'` keeps `'text'` under section 1.4 rule 3. The stricter classification wins. `envType` returns `'secret'`, the value enters `Secrets` and is redacted wherever eligible, and `{ type: 'env' }` system-prompt interpolation is refused.
3. **Credential stored with `{ type: 'text' }` and no secret declaration.** `envType` returns `'text'`, and Spindle does not sniff patterns to guess secrecy. If those exact bytes were also learned from an actual secret source (such as `instanceEnv` or another `'secret'` key), that secret source still triggers redaction.
4. **Short non-secret word stored with default `'secret'` type.** Calling `setEnv('GATE', 'open')` stores `type: 'secret'`. `envType('GATE')` returns `'secret'` and direct `{ type: 'env', property: 'GATE' }` interpolation is refused, while substring redaction skips `'open'` because it is shorter than 8 code points.
5. **Secret rotation via `setEnv`.** Calling `setEnv('API_TOKEN', newToken)` without `options.type` keeps `type: 'secret'`, registers `newToken` into `Secrets`, and retains the previous value in `Secrets` for the remainder of the current execution so an earlier read cannot leak.
6. **Malformed `setEnv` inputs or stale handle.** Invalid name, lone surrogate key, non-string value, invalid `options.type`, terminated thread, or expired/superseded handle rejects without modifying the thread.

## 7. Ledger coverage and statements found while reading

Every M2b ledger ID is mapped below to its governing section in this note or in `docs/plans/m2b-tools-and-values.md` and to exactly one pull request.

| Ledger ID | Design or plan section | Pull request |
|---|---|---|
| `specification:threads:4495359b` | `secrets.md` §1.2, §1.4 rule 12 | M2b-1 |
| `specification:threads:6a7a34b7` | `secrets.md` §1.2, §1.4 rule 13 | M2b-1 |
| `specification:threads:4e919532` | `secrets.md` §1.4 rules 1 to 8 (settled `partial`, propagation owed by M3b per rule 9) | M2b-1 |
| `specification:threads:274ed7a7` | `secrets.md` §1.1 (settled `deferred`) | M2b-1 |
| `specification:tools:462ec47b` | `secrets.md` §1.1 (settled `deferred`) | M2b-1 |
| `specification:threads:e1c56064` | `secrets.md` §2.1 rules 1 to 2 | M2b-2 |
| `specification:prompts:61b7d2b3` | `secrets.md` §2.1 rules 3 to 9 | M2b-2 |
| `infrastructure:runtime:0496b9da` | `m2b-tools-and-values.md` M2b-3 | M2b-3 |
| `specification:prompts:23ec065b` | `m2b-tools-and-values.md` M2b-3 | M2b-3 |
| `specification:prompts:bf53f925` | `m2b-tools-and-values.md` M2b-3 | M2b-3 |
| `specification:prompts:949d0585` | `m2b-tools-and-values.md` M2b-3 | M2b-3 |
| `specification:prompts:64c83f9a` | `m2b-tools-and-values.md` M2b-3 | M2b-3 |
| `specification:prompts:551cdfc5` | `m2b-tools-and-values.md` M2b-3 | M2b-3 |
| `specification:prompts:8ccbefff` | `m2b-tools-and-values.md` M2b-3 | M2b-3 |
| `infrastructure:runtime:fc8c359f` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |
| `infrastructure:runtime:022219f5` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |
| `specification:agents:8fb03a6e` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |
| `specification:agents:cda6e847` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |
| `specification:agents:2f2416ed` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |
| `specification:agents:6e269b7f` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |
| `specification:agents:e7466e70` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |
| `specification:agents:050c4e51` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |
| `specification:agents:5585bfa6` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |
| `specification:agents:a9937a20` | `m2b-tools-and-values.md` M2b-4 | M2b-4 |

### Found while reading, to add to the ledger

The normative statements below appear in the pinned spec (`f462a673297faed1f849ef1741ddda1e06b6c817`) without RFC 2119 keywords and are missing from `packages/conformance/requirements.extra.json`. Add them to `requirements.extra.json` and `ledger.json` during the M2b pull request that covers each one.

1. `specification/threads.md:27` (1.1 Agent Assignment). Manual handoff queues a tool call to an agent to trigger handoff programmatically (M2b-4).
2. `specification/threads/execution-state.md:38` (2.1 Prompt Path). Inside a sub-prompt, `promptPath` is `['my_prompt', 'sub_prompt']` (M2b-3).
3. `specification/threads/execution-state.md:39` (2.1 Prompt Path). After a handoff, `promptPath` is `['new_agent_prompt']` (M2b-4).
4. `specification/prompts.md:129` (3.3 Sub-Prompt Tool Configuration). Sub-prompt result options apply only to sub-prompts and not to regular function tools (M2b-3).
5. `specification/prompts.md:158` (3.3 Sub-Prompt Tool Configuration). `includeTextResponse` defaults to `true` and controls whether the sub-prompt's text response is included in the result string (M2b-3).
6. `specification/prompts.md:159` (3.3 Sub-Prompt Tool Configuration). `includeToolCalls` defaults to `true` and controls whether the sub-prompt's tool calls and results are serialized into the result string (M2b-3).
7. `specification/prompts.md:160` (3.3 Sub-Prompt Tool Configuration). `includeErrors` defaults to `true` and controls whether errors from the sub-prompt are serialized into the result string (M2b-3).
8. `specification/prompts.md:161` and `164` (3.3 Sub-Prompt Tool Configuration). `initUserMessageProperty` uses the named argument property as the initial user message when invoking a sub-prompt or handoff agent (M2b-3 and M2b-4).
9. `specification/tools.md:63` (3. Variable Declarations). `scoped: true` blocks inheritance from parent thread env for that variable name (M3b).
10. `specification/tools.md:64` (3. Variable Declarations). Scoped variables still flow downward from the thread where they are declared or provided to descendants in that subtree (M3b).
11. `specification/agents.md:119` (4. Stop Semantics). Runtime stop evaluation order for prompt-backed sides puts session-level terminal bindings (`sessionStop` / `sessionFail`) first (M2b-4. Lines 120 to 122 are already curated).

## 8. Still open for M4

- Design question 5 from `docs/plans/milestones.md` (where trusted in-process access ends, and what public projection endpoints and client streams expose) belongs to the M4 trust-boundary design note.
- Cross-thread attachment copying for `sessionStop`/`sessionFail` `attachmentsProperty` (`specification:agents:38b9d170`) waits for M3a and M3b.
- Parent-registry updates, child-to-parent completion delivery, and `parentHooks` activation on handoff targets (`specification:agents:33001fe2`) wait for M3b.
