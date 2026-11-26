# Code Quality Review: PR 7 (`m1/5-hooks` — Hooks at every position of the step loop)

- **PR:** `zacharytamas/spindle-runtime` PR 7 (`m1/5-hooks`)
- **Base / Head:** `2eb5f77` (`origin/m1/4-step-loop`) .. `7d27f41` (`origin/m1/5-hooks`)
- **Verified at stack tip:** `43a4d5b` (`origin/m1/7-chat`)
- **PR 7 code already gone at tip:** PR 7's at-rest `sendMessage` message-insert path in `packages/runtime/src/execution/trigger.ts` was replaced by `ThreadSupervisor.send` + `step.ts` drain in PR 8; PR 7's local `isAttachmentRef` in `packages/runtime/src/execution/hooks.ts` moved to `packages/runtime/src/store/schema.ts` in PR 8 (though `tools.ts:81` still carries an older weaker duplicate).

---

## 1. Verdict

**Does not pass the review bar.** Behavior is carefully specified and heavily tested, and several underlying mechanisms (the SQLite revision triggers paired with `history.ts`, `argumentWatcher`, and redacting after hooks so late-learned secrets are caught) are solid. The single largest thing wrong is that PR 7 built hooks as one untyped, cast-backed runtime table (`hooks.ts`) and threaded all thirteen positions by hand through a giant step loop (`step.ts`) and a writer-mode switch (`messages.ts`), rather than modeling the three real hook archetypes (observer, keep-transformer, veto-transformer) with typed Effect `Schema` boundary decoders and letting the four decorated boundaries (`trigger.ts`, `messages.ts`, `assemble.ts`, `tools.ts`) own their hooks. That one structural choice caused most of the maintainability cost visible at the top of the stack: 210 lines of hand-written boundary predicates that throw away types and force 10 `as` casts in `assemble.ts`, an `unsafeEffectTypeAssertion` that leaks `HookFailed` into `step.ts`, a `Writer` enum in `messages.ts` onto which PR 8 bolted `"queued"` and `"skipped"` special cases, a 778-line `step.ts` with 7 manual `runHooks` calls and circular closure knots, and two new conformance files over 1,000 lines (`hooks.ts` at 2,064 lines, `messages.ts` at 1,047 lines).

---

## 2. Structural Findings

### S1. `hooks.ts` forces 3 distinct hook archetypes into one untyped table and one cast-ridden `runHooks` function

- **Location:** `packages/runtime/src/execution/hooks.ts:26-57`, `packages/runtime/src/execution/hooks.ts:282-336`, `packages/runtime/src/execution/hooks.ts:453-521`
- **Cost to maintainers:** The `POSITIONS` table looks uniform, but `runHooks` fights it at every turn: `lead: ReadonlyArray<unknown>` erases argument types for every caller, `Values` invents dummy types for observers (`after_thread_created: undefined`, `tool_call_started: string | undefined`), line 479 hardcodes `position === "after_thread_created" ? [] : [structuredClone(current)]`, `options.essential` dynamically flips `row.failure` from `"veto"` to `"keep"`, and line 521 casts the entire `Effect.gen` with `as Effect.Effect<Values[K], K extends Vetoes ? HookFailed : never>`. Cloning arguments inside `args()` inside `invokeCallback` (lines 476–483) also misclassifies a clone failure (`H12e`) as `"threw an error"` from the hook even though the hook never ran, and half of `row.accept` functions return `INVALID` while the other half throw (`structuredClone`), forcing a `try/catch` inside `Effect.gen` (lines 501–505).
- **Proposed restructuring:** Split hook dispatch into three small, strongly typed entrypoints sharing one internal single-hook pipeline (`cloneArgs -> invokeWithDeadline -> decode -> check -> logOrFail`):
  - **5 observers** (`after_thread_created`, `after_create_message`, `after_update_message`, `tool_call_started`, `tool_call_done`) -> `observeHooks(scope, position, args, options)` returning `Effect.Effect<void, never>`.
  - **8 transformers in keep mode** (`after_system_message`, `filter_messages`, `prefilter_llm_history`, `before_store_tool_result`, `after_tool_call_success`, `after_tool_call_failure`, plus essential `before_create_message`) -> `transformHooks(scope, position, args, value, options)` returning `Effect.Effect<V, E, R>` (where `E` comes only from `options.check`, never `HookFailed`).
  - **2 transformers in veto mode** (optional `before_create_message`, `before_update_message`) -> `vetoHooks(scope, position, args, value, options)` returning `Effect.Effect<V, HookFailed | E, R>`.

  Sketch:
  ```ts
  // Typed argument tuples per position (no untyped lead: ReadonlyArray<unknown>)
  interface ObserverArgs {
    readonly after_thread_created: readonly []
    readonly after_create_message: readonly [message: Message]
    readonly after_update_message: readonly [message: Message]
    readonly tool_call_started: readonly [toolCall: HookToolCall, progress: string | undefined]
    readonly tool_call_done: readonly [toolCall: HookToolCall, result: ToolResult]
  }
  interface TransformSpec<Lead extends ReadonlyArray<unknown>, V> {
    readonly where: string
    readonly expects: string
    readonly kept: string
    readonly cloneValue: (value: V) => V
    readonly accept: (returned: unknown, current: V) => Option.Option<V>
  }
  // One shared runner:
  // 1. clone lead + value via Effect.try (on clone failure, log isolation failure and keep/veto without calling hook)
  // 2. Effect.tryPromise(invokeCallback) |> Effect.timeoutOption(timeout) |> Effect.timed
  // 3. check elapsed > timeout, mark call.expired, delete pending
  // 4. accept(returned, current) -> Option (never throws)
  // 5. optional check(next, current, hook.id) preserving its E/R channels
  // 6. on problem: Effect.logWarning(...), then either fail(HookFailed) (veto) or keep current
  ```
  Checked against `H12e` (`packages/conformance/src/scenarios/hooks.ts:813-847`): `H12e` asserts `result?.content` contains `"original"` and `called === false`, and does not assert the warning text claims the hook threw. Checked against `H21`, `H10`, `H15`, `H15b`, `H16`, `H23`, `H23b`: all argument orders, warning prefixes (`Hook <id> (<position>, ...)`), and `HookFailed` messages stay identical. Also future-proofs M3's `after_subagent_created`, whose second argument is a non-cloneable `childState: ThreadState`.
- **Line estimate:** `-45` to `-60` net lines in `hooks.ts`; deletes `HookFailed` from `step.ts`'s error union.
- **Risk & guarding tests:** Low risk of changing warning wording or argument ordering; guarded by `H8`, `H9`, `H9b`, `H9c`, `H10`, `H12`–`H16`, `H21`, `H23`, `H23b`, `I1`–`I7`, and `packages/runtime/test/execution/hooks.test.ts`.
- **PR & ripple:** Carry in **PR 7** (`m1/5-hooks`). Ripples through PR 8 (`m1/6-queue`) where `step.ts`, `messages.ts`, and `hooks.ts` (`Callback`/`PendingCallbacks`) are edited; minimal rebase in PR 10 (`m1/7-chat`).
- **Effect API verification:** Verified `Effect.try` (`node_modules/effect/dist/Effect.d.ts:2432`), `Effect.tryPromise` (`Effect.d.ts:1363`), `Effect.timeoutOption` (`Effect.d.ts:8604`), `Effect.timed` (`Effect.d.ts:8972`), `Duration.isGreaterThan` (`Duration.d.ts:1673`), and `Option` in `node_modules/effect/dist`.

---

### S2. `messages.ts` hides two different error contracts and five writer-specific policies inside one `createMessage` function

- **Location:** `packages/runtime/src/execution/messages.ts:88-209` (callers at `packages/runtime/src/execution/step.ts:486,524-538,574,669` and `packages/runtime/src/execution/thread-state.ts:268-281`)
- **Cost to maintainers:** PR 7 introduced `Writer = "injection" | "result" | "turn"` and branched on `writer` and `essential = writer !== "injection"` at four points inside `createMessage`. Because one function carried every write policy, PR 8 added `"queued"` and `"skipped"` to `Writer` and inserted two more feature-specific branches straight into `messages.ts`: lines 165–170 re-parse and re-redact `original.tool_calls` JSON (already redacted once at `step.ts:516`), and lines 171–179 silently overwrite `role`, `name`, `tool_call_id`, `tool_status`, and `content` back to `original` *after* `before_create_message` hooks accepted edits. Conflating optional and essential writes in one signature also leaks `HookFailed | MessageIdTaken` into `step.ts`'s `runExecution` return type even though `step.ts` never makes an optional write.
- **Proposed restructuring:** Split `createMessage` into two public functions with exact error contracts sharing one internal helper `writeMessage`:
  - `injectMessage(write, draft)` — optional/vetoable write; uses `vetoHooks(..., "before_create_message")`, skips pre-insert `messageIdTaken`, fails with `HookFailed` on late-learned secret id, propagates `MessageIdTaken` from the store, and always redacts `["content", "metadata"]`. Return error channel includes `HookFailed | MessageIdTaken`.
  - `commitMessage(write, draft, policy, dequeue?)` — essential write; uses `transformHooks(..., "before_create_message")` with `store.messageIdTaken` check, reverts late-learned secret id to `original.id` with a warning, retries once on `MessageIdTaken` with a fresh UUID. Return error channel excludes both `HookFailed` and `MessageIdTaken`.
  - Replace the 5-variant `Writer` union with a tiny policy object passed by the caller:
    ```ts
    export interface CommitPolicy {
      readonly redactedFields: ReadonlyArray<RedactedField>
      readonly preserveErrorCode?: boolean
      readonly finalize?: (original: Message, redacted: Message, redact: (text: string) => string) => Message
    }
    ```
    `turn` is `{ redactedFields: [] }`; `result` is `{ redactedFields: ["content", "metadata", "attachments"], preserveErrorCode: true }`; `queued` and `skipped` stay local to `step.ts` via `finalize` (and `queued` redacts `entry.args` once in `finalize`, removing the double redaction between `step.ts:516` and `messages.ts:168`).
  - **Operator decision note (for PR 8's `"skipped"` branch):** `messages.ts:171-179` silently discards hook edits to `content`/`name`/`tool_status` on a stop-skipped tool result rather than rejecting them or keeping them; keeping `finalize` preserves exact current behavior, and moving it to `step.ts` makes that policy explicit where skipped calls live.
- **Line estimate:** `-35` lines in `messages.ts`, net `-20` lines across `messages.ts` + `step.ts`; removes 2 phantom error types from `runExecution`.
- **Risk & guarding tests:** Medium risk around ID-collision retry and late-learned secret IDs; guarded by `H9`, `H9b`, `H9c`, `H10`, `H22`, `H22b`, `H22c`, `I1`, `I2`, `I4`, `I5`, `M1`, `packages/runtime/test/execution/history.test.ts:217-236`, and PR 8's `queue.ts` / `ownership.ts` scenarios.
- **PR & ripple:** Carry the `injectMessage`/`commitMessage` + `CommitPolicy` split in **PR 7** (`m1/5-hooks`). PR 8 (`m1/6-queue`) then passes `finalize` from `step.ts` instead of editing `messages.ts` with `"queued"` and `"skipped"`. No ripple into PR 10.
- **Effect API verification:** Verified `Effect.catchTag` (`Effect.d.ts:4463`) and `Effect.fn` (`Effect.d.ts:19640`) in `node_modules/effect/dist`.

---

### S3. `step.ts` calls hooks by hand at 7 inline sites and wires a circular closure knot instead of letting the 4 decorated boundaries own their hooks

- **Location:** `packages/runtime/src/execution/step.ts:362-421`, `packages/runtime/src/execution/step.ts:442-501`, `packages/runtime/src/execution/step.ts:541`, `packages/runtime/src/execution/step.ts:612-646`, and `packages/runtime/src/execution/trigger.ts:14-49`
- **Cost to maintainers:** `runExecution` is now 525 lines inside a 778-line `step.ts`. It imports 10 micro-functions from `assemble.ts` and 6 symbols from `hooks.ts` to orchestrate all 7 assembly steps inline (`step.ts:612-646`), runs all 5 tool-hook positions across three local closures (`streamed`, `runCall`, `runQueuedTool`), and wires five mutually referencing closure bags (`base`, `hooks`, `inbound`, `toolContext`, `promptState`) where `hooks` closes over `base` defined below it and `inbound` duplicates `trigger.ts`'s `atRest` and `noInvoke`. Adding or changing any hook position forces edits straight into the middle of the step loop.
- **Proposed restructuring:** Make every one of the 13 hook positions fall out of the 4 domain operations that own the data:
  1. **Thread creation (`trigger.ts`, 1 position):** `createThread` already owns `after_thread_created`. Extract one shared `makeAtRestHooks(thread, agent, secrets, control, services, owner?)` helper used by both `trigger.ts:atRest` and `step.ts`'s inbound drain (deleting duplicated `noInvoke` and inline `inbound` setup).
  2. **Message writes (`messages.ts`, 4 positions):** `injectMessage` / `commitMessage` and `updateMessage` already own `before/after_create_message` and `before/after_update_message`.
  3. **Request assembly (`assemble.ts`, 3 positions):** Move `step.ts:612-646` into one `assembleRequest(ctx, view, signal)` in `assemble.ts` covering all 7 steps (`renderSystemPrompt -> after_system_message -> checkSystemPrompt -> history.read -> filter_messages -> toProviderMessages -> prefilter_llm_history -> withoutReasoning -> checkSystemMessages -> checkSystemPrompt -> buildRequest`), taking a `record` callback for the 7 trace lines. `step.ts` shrinks from 10 imports and 35 inline lines to one call.
  4. **Tool execution (`tools.ts`, 5 positions):** Move `runCall` (`step.ts:462-501`) into `completeToolCall` in `tools.ts` (owning `after_tool_call_success`, `after_tool_call_failure`, `before_store_tool_result`, storage + fallback, and `tool_call_done`), and move `streamed` (`step.ts:442-459`) plus `notifyToolStarted` (`step.ts:541`) into a small `streamedCallHooks(hooks, turn)` helper in `tools.ts`.

  After this restructuring, **`step.ts` has zero calls to `runHooks` and zero `has`/`countHooks` checks**. Its main loop reads directly as `drain -> assembleRequest -> callModel -> commitMessage(response) -> completeToolCall (per call) -> stopReason -> release`.
- **Line estimate:** Removes ~160–190 lines from `step.ts` (bringing it from 778 to ~600 lines) and deletes ~35 duplicated lines between `step.ts` and `trigger.ts`; net `-50` to `-70` lines across `execution/`.
- **Risk & guarding tests:** Low-to-medium risk of subtly reordering trace lines or snapshot timing (remember `history.test.ts:261-296` checks that no `observe`/`record` runs between `history.read` and `filter_messages`!). Guarded by all `H8`–`H23b`, `M1`–`M8d`, `I1`–`I10`, `S01`–`S33`, and `test/execution/history.test.ts`.
- **PR & ripple:** Carry in **PR 7** (`m1/5-hooks`), where all 7 inline hook sites were added to `step.ts`. Ripples through PR 8 (`m1/6-queue`, which added `inbound`, `runQueuedTool`, `skipped`, and `run.stop` checks inside `step.ts`) and lightly through PR 10 (`m1/7-chat`).
- **Effect API verification:** Uses standard `Effect.fn` / `Effect.gen` composition already verified in `Effect.d.ts`.

---

### S4. ~210 lines of hand-written boundary validators in `hooks.ts` discard types, diverge across files, and force 10 `as` casts in `assemble.ts`

- **Location:** `packages/runtime/src/execution/hooks.ts:59-270`, `packages/runtime/src/execution/assemble.ts:328-368`, `packages/runtime/src/execution/tools.ts:55-85,143-150`
- **Cost to maintainers:** `hooks.ts` hand-writes 15 boolean predicates (`isMessage`, `isContentPart`, `isCall`, `isReasoningDetail`, `isLLMMessage`, `isNewFile`, `acceptResult`, etc.) that discard the narrowed TypeScript types (`value as Array<LLMMessage>` at `hooks.ts:303`, `value as unknown as ToolResult` at `hooks.ts:268`). Because the type is thrown away, `assemble.ts:328-368` (`callFrom` and `fromLLMMessage`) carries **10 `as` casts** relying on a comment that says `hooks.ts has checked each message`. Meanwhile, the hand-written checks already drifted in two real ways:
  1. `acceptMessages` (`hooks.ts:231`) uses `value.every(isMessage)`, which skips sparse-array holes (contradicting `isListOf` 55 lines earlier at `hooks.ts:174`) and admits cloneable non-JSON objects like `Date` in `metadata`.
  2. `tools.ts:81-82` keeps a stale, weaker `isAttachmentRef` checking only `type`, `id`, and `path`, disagreeing with canonical `store/schema.ts:217-227` (`user-code-at-the-edge.md` Gap 3), while `tools.ts:143-150` (`readResult`) overlaps `hooks.ts:260-270` (`acceptResult`).
- **Proposed restructuring:** Replace the hand-written shape predicates with Effect v4 `Schema` definitions shared across the boundary (`store/schema.ts` or `execution/hook-schemas.ts`):
  - `SafeCount = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))` (verified: rejects `-1`, `1e20`, `NaN`; accepts `0` and `MAX_SAFE_INTEGER`).
  - `JsonRecord = Schema.Record(Schema.String, Schema.Json)` (verified: rejects `Date`, `BigInt`, `NaN`, and objects with `toJSON` methods).
  - `MetadataField = Schema.Union([JsonRecord, Schema.fromJsonString(JsonRecord)])` (replaces `metadataOf` at `hooks.ts:81-90`).
  - `AttachmentRefSchema`, `NewFileSchema`, `MessageSchema`, `LLMMessageSchema` (4-variant `Schema.Union` on `role`, with `ContentPartSchema`, `CallSchema`, `ReasoningDetailSchema`), and `ToolResultSchema`.
  - Keep the single-pass snapshot (`plain` via `toJson` for stored values, `structuredClone` for request values) inside `Effect.try` **before** calling `Schema.decodeUnknownOption` — verified empirically against Effect 4.1.5 that `Schema.decodeUnknownOption` throws a defect if a getter throws, while `Schema.Array` automatically rejects sparse arrays (`I7`) without needing `isListOf`.
  - Have `prefilter_llm_history` decode into the narrowed `ValidatedLLMMessage` discriminated union so `fromLLMMessage` and `callFrom` in `assemble.ts` have **zero `as` casts**.
  - Delete `tools.ts:81-82`'s weak `isAttachmentRef` and reuse `AttachmentRefSchema` (or `store/schema.ts:isAttachmentRef`) in `tools.ts`, `hooks.ts`, and `ThreadSupervisor.ts`.
  - Note: keep `acceptUpdate`'s relational key check (`Object.hasOwn(current, key) && current[key] === value`) as a small 8-line function after `plain()` + `MetadataField` decoding, because it compares against `current`.
- **Line estimate:** Removes `~130` to `~160` net lines across `hooks.ts`, `assemble.ts`, `tools.ts`, and `store/schema.ts`, eliminates 12 `as` casts, and closes Gaps 3 & 5 of `docs/design/user-code-at-the-edge.md`.
- **Risk & guarding tests:** Low-to-medium risk of subtle schema strictness differences (e.g., extra keys on `Message` vs `Schema.Struct` stripping them; `filter_messages` callers expecting `Message` fields preserved — checked: `MessageSchema` declares all stored `Message` fields plus optional subagent fields, and `H9b`, `H11b`, `H14`, `H23`, `H23b`, `I1`, `I4`, `I7` exercise every corner case). Performance on 400-message histories with `filter_messages` should be benchmarked once (see Section 6).
- **PR & ripple:** Carry in **PR 7** (`m1/5-hooks`) for `hooks.ts`, `assemble.ts`, and `tools.ts` (and optionally pull `AttachmentRefSchema` into PR 4 `store/schema.ts`). Ripples into PR 8 (`ThreadSupervisor.ts:94`).
- **Effect API verification:** Verified `Schema.Struct` (`Schema.d.ts:3037`), `Schema.Record` (`Schema.d.ts:3374`), `Schema.Union` (`Schema.d.ts:4184`), `Schema.Literals` (`Schema.d.ts:4239`), `Schema.NullOr` (`Schema.d.ts:4261`), `Schema.optional` (`Schema.d.ts:2037`), `Schema.Array` (`Schema.d.ts:3943`), `Schema.Int` (`Schema.d.ts:6234`), `Schema.check` (`Schema.d.ts:4369`), `Schema.isGreaterThanOrEqualTo` (`Schema.d.ts:6108`), `Schema.Json` (`Schema.d.ts:12989`), `Schema.fromJsonString` (`Schema.d.ts:7292`), and `Schema.decodeUnknownOption` (`Schema.d.ts:1345`) in `node_modules/effect/dist/Schema.d.ts`, plus runtime behavior on sparse arrays, `1e20`, `Date`, `toJSON`, and throwing getters in Node against `effect@4.1.5`.

---

### S5. Tool-result persistence catches `ValueNotJson` *after* `before_create_message` runs, causing hooks to run twice on unstorable results

- **Location:** `packages/runtime/src/execution/step.ts:480-494`, `packages/runtime/src/execution/tools.ts:253-286`
- **Cost to maintainers:** When a tool returns an unstorable attachment or non-JSON `error_data` (such as a `BigInt`, a function, or a throwing getter on an attachment) and no `before_store_tool_result` hook rejects it, `storedResult` (`tools.ts:253`) only shallow-copies attachment refs (`{ ...item }`) and `structuredClone`s `error_data` (which still admits `BigInt`, `Date`, `Map`, etc.). `save` then calls `createMessage`, which runs all `before_create_message` hooks (and their side effects), fails at `store.insertMessage` with `ValueNotJson`, and catches `ValueNotJson` at `step.ts:491` to call `save(unstorableResult(final, error.message))` — running `before_create_message` a **second time** for the same tool call. That repeats hook side effects and contradicts the single-pass rule that PR 7 specifically fixed for ID collisions (`I2`).
- **Proposed restructuring:** Run `toJson` on `refs` and `error_data` inside `storedResult` (or a small `prepareStoredResult` helper in `tools.ts`), converting any `NotJson` or getter error into `unstorableResult` **before** calling `commitMessage`. Then `commitMessage` receives a JSON-valid draft and `before_create_message` runs strictly once per tool result.
- **Line estimate:** `~0` net lines (`+6 / -6` across `tools.ts` and `step.ts`).
- **Risk & guarding tests:** Low risk; preserves `S14`, `S14b`, `S15`, `S24`, `H12c`, `H12e`, `H14`, and closes the double-hook-execution part of `user-code-at-the-edge.md` Gap 3.
- **PR & ripple:** Carry in **PR 7** (`m1/5-hooks`), where `createMessage` was wrapped inside `save`'s `catchTag("ValueNotJson")`. Clean trivial rebase in PR 8 (`m1/6-queue`).
- **Effect API verification:** Uses existing `toJson` (`store/schema.ts:272`) and `Effect.try` (`Effect.d.ts:2432`).

---

### S6. The module-global `positions` `WeakMap` leaks store internals across 4 execution files and breaks across `filter_messages` clones

- **Location:** `packages/runtime/src/store/ThreadStore.ts:175-185`, `packages/runtime/src/execution/history.ts:47-50`, `packages/runtime/src/execution/step.ts:625-631`, `packages/runtime/src/execution/assemble.ts:189-192,248-270`
- **Cost to maintainers:** To track `(seq, callerSeq)` without modifying the public `Message` type, PR 8 (`a224d03`) introduced a module-global `WeakMap<Message, MessagePosition>` (`positions`) and patched PR 7's `history.ts`, `step.ts`, and `assemble.ts` to maintain it by hand. Because `filter_messages` clones messages (breaking object identity), `step.ts:625-631` has to rebuild a `Map` from `snapshot` and mutate `positions` on every cloned message mid-loop, and `history.ts:48-49` has to mirror `positions` onto `duplicate`. Matching by `m.id` in `step.ts:628` also silently attaches old `(seq, callerSeq)` metadata if a `filter_messages` hook replaces a message with the same `id`.
- **Proposed restructuring:** Keep `(seq, callerSeq)` as explicit data alongside `messages` instead of hidden global state: have `ThreadHistory` / `History.read` return `{ messages, positions: ReadonlyMap<string, MessagePosition> }` (or an internal `IndexedMessage` wrapper whose `.message` is projected at the `ThreadState` and hook boundary), and pass `positions` explicitly into `toProviderMessages(filtered, view, positions)`. That deletes the global `WeakMap`, removes `positions` imports from `history.ts` and `step.ts`, and makes the data flow visible in function signatures.
- **Line estimate:** `-15` to `-20` net lines across `ThreadStore.ts`, `schema.ts`, `history.ts`, `step.ts`, and `assemble.ts`.
- **Risk & guarding tests:** Low risk; guarded by `I10`, `S04`, `M8`–`M8d`, `packages/runtime/test/execution/history.test.ts`, and PR 8's `ownership.ts` / `claims.test.ts`.
- **PR & ripple:** Carry in **PR 8** (`m1/6-queue`, commit `a224d03` introduced `positions` and the patches to `history.ts` and `step.ts`). Does not need to touch PR 7; zero ripple to PR 10.
- **Effect API verification:** Pure data restructuring; no Effect APIs changed.

---

### S7. PR 7 pushes two new conformance scenario files well past the 1,000-line ceiling

- **Location:** `packages/conformance/src/scenarios/hooks.ts:1-2064`, `packages/conformance/src/scenarios/messages.ts:1-1047`
- **Cost to maintainers:** Both files were created from scratch in PR 7 past the 1,000-line presumptive blocker threshold (`hooks.ts` is over 2,000 lines). Scanning or editing a single scenario requires navigating thousands of lines of inline fixtures, and test helpers are duplicated within and across files (`settle` at `hooks.ts:312` and `hooks.ts:454`; `noop` at `hooks.ts:18` and `messages.ts:22`).
- **Proposed restructuring:** Decompose `packages/conformance/src/scenarios/hooks.ts` into focused modules under `packages/conformance/src/scenarios/hooks/` (`selection.ts` for H8/H21, `persistence.ts` for H9/H9b/H9c/H10/H18/H20, `request.ts` for H11/H11b, `tools.ts` for H12–H14, `guards.ts` for H15–H16/H22–H23b, and `helpers.ts` for shared `settle`/`noop`/`toolRows`/`ref`), keeping `scenarios/hooks.ts` as a 10-line barrel exporting `hookScenarios`. Split `scenarios/messages.ts` into `scenarios/messages/visibility.ts` and `scenarios/messages/live-history.ts` (~500 lines each), re-exported from `scenarios/messages.ts`.
- **Line estimate:** `-40` lines of duplicated helpers; brings every scenario file under ~550 lines.
- **Risk & guarding tests:** Zero behavioral risk; `packages/runtime/test/conformance.test.ts` and `pnpm ledger` verify every scenario name and requirement ID stays intact.
- **PR & ripple:** Carry in **PR 7** (`m1/5-hooks`). Minor rebase in PR 8 (`m1/6-queue`, which modified 27 lines of `scenarios/messages.ts`).
- **Effect API verification:** Not applicable (test files).

---

### S8. Three PR 7 data paths grow linearly with thread length on every step (`O(N^2)` over a long thread)

- **Location:** `packages/runtime/src/execution/history.ts:50`, `packages/runtime/src/execution/hooks.ts:479`, `packages/runtime/src/execution/assemble.ts:218`
- **Cost to maintainers:** Even though micro-optimization is out of scope, three structures introduced in PR 7 scale with the full length `N` of the thread on every single write or step:
  1. `history.ts:50`: `copy.messages.concat([duplicate])` copies all `N` references on every insert (`O(N)` per message -> `O(N^2)` over a thread, noted in Appendix A line 857).
  2. `hooks.ts:479`: `structuredClone(current)` deep-clones the entire `N`-message snapshot for every `filter_messages` hook on every step (8 ms at 5,000 messages per Appendix A line 859), ignoring `history.ts:16`'s `copyMessage` which PR 7 already wrote to avoid `structuredClone`'s cost on `Message` objects.
  3. `assemble.ts:218`: `results.set(at, [...(results.get(at) ?? []), index])` reallocates the bucket array on every tool result in a call group (`O(K^2)` in group size) instead of mutating a local array inside `requestOrder`.
- **Proposed restructuring:**
  1. In `history.ts`, keep an internal mutable array plus a `shared` flag (or slice-on-snapshot): when `read` returns a snapshot, mark the backing array shared (or return `messages.slice()`), and only copy-on-write on the first `inserted` after a `read`, avoiding copies on consecutive inserts between snapshots (still preserving `M5b`'s snapshot immutability).
  2. In `hooks.ts` (under S1's `TransformSpec.cloneValue`), use `(msgs) => msgs.map(copyMessage)` for `filter_messages` instead of `structuredClone`.
  3. In `assemble.ts:218`, push into the bucket array in place (`let list = results.get(at); if (!list) { list = []; results.set(at, list) }; list.push(index)`).
- **Line estimate:** `+5` net lines.
- **Risk & guarding tests:** Low risk; snapshot immutability is guarded by `M5b` and `packages/runtime/test/execution/history.test.ts` (specifically the deep-copy and twenty-step tests), and `I10` guards `requestOrder`.
- **PR & ripple:** Carry in **PR 7** (`m1/5-hooks`). No ripple beyond clean rebases in PR 8.
- **Effect API verification:** Pure TypeScript data structures; no Effect APIs changed.

---

## 3. Effect Practice Findings

### E1. `unsafeEffectTypeAssertion` in `hooks.ts` erases compile-time checking of the error channel

- **Location:** `packages/runtime/src/execution/hooks.ts:467`, `packages/runtime/src/execution/hooks.ts:521`
- **Confirmed `@effect/tsgo` diagnostic (`unsafeEffectTypeAssertion`):** `packages/runtime/src/execution/hooks.ts:467:3 - This type assertion unsafely narrows the error or requirements channels.`
- **Cost to maintainers:** Because `runHooks` mixes `keep` and `veto` modes under one conditional return type `Effect.Effect<Values[K], K extends Vetoes ? HookFailed : never>`, TypeScript cannot prove the body matches the signature and requires an `as` cast. That both hides bugs inside `runHooks` (any accidental error yield is silently cast away) and leaks `HookFailed` into `step.ts`'s `runExecution` return type whenever `before_create_message` is called with `essential: true`.
- **Proposed restructuring:** Split into `observeHooks`, `transformHooks` (`E = never`), and `vetoHooks` (`E = HookFailed`) as sketched in S1, deleting the `as` assertion entirely.
- **Line estimate:** Included in S1 (`-1` cast, removes `HookFailed` from `step.ts`).
- **Risk & guarding tests:** Zero behavioral risk; verified by `pnpm typecheck` and all hook scenarios.
- **PR & ripple:** **PR 7** (`m1/5-hooks`), ripples to PR 8 callers.
- **Effect API verification:** Verified `Effect.gen` inference with `@effect/tsgo@0.73.7` in scratch.

---

### E2. `Effect.orDie` in `messages.ts:159` turns a typed `SqlError` into an untyped defect because `hooks.ts` pins `check` to `E = never`

- **Location:** `packages/runtime/src/execution/messages.ts:159`, `packages/runtime/src/execution/hooks.ts:464`
- **Cost to maintainers:** `runHooks` types `options.check` as `(next, current, hook) => Effect.Effect<string | undefined>` (hardcoding `E = never, R = never`), forcing `messages.ts:159` to write `yield* store.messageIdTaken(next.id).pipe(Effect.orDie)`. In `step.ts:719-745`, a typed `SqlError` settles the run as `step_error`, whereas a defect settles as `fatal_error` — so `.pipe(Effect.orDie)` silently changes failure semantics on a database error during `before_create_message`.
- **Proposed restructuring:** Make `check` generic over `<E = never, R = never>`:
  `readonly check?: (next: V, current: V, hook: string) => Effect.Effect<string | undefined, E, R>`,
  include `E` and `R` in `transformHooks` / `vetoHooks`, and remove `.pipe(Effect.orDie)` at `messages.ts:159`.
- **Line estimate:** `0` net lines (`-1` `.pipe(Effect.orDie)`, `+2` type params).
- **Risk & guarding tests:** Low risk; `SqlError` is already in `createMessage`'s error union via `store.insertMessage`. Guarded by `H9c`, `I2`, and `step-loop.ts` error-classification scenarios.
- **PR & ripple:** **PR 7** (`m1/5-hooks`). Clean rebase in PR 8.
- **Effect API verification:** Verified `Effect.Effect<A, E, R>` type inference in `Effect.d.ts`.

---

### E3. Manual parameter bags (`WriteContext`, `StateContext`, `HookScope`) duplicate what `Context.Reference` and `Context.Service` already do in this codebase

- **Location:** `packages/runtime/src/execution/messages.ts:18-29`, `packages/runtime/src/execution/hooks.ts:352-363`, `packages/runtime/src/execution/thread-state.ts:89-107`, `packages/runtime/src/execution/step.ts:367-420`, `packages/runtime/src/execution/trigger.ts:30-48`
- **Cost to maintainers:** The execution layer already uses `Context.Reference` for `HookTimeout` (`hooks.ts:17`), `NestedWriteLimit` (`hooks.ts:23`), and `WritingHandle` (`ThreadStore.ts:164`), yet threads `call: HookCall | undefined` and `hooks: HookScope` by hand through `StateContext` (14 fields), `WriteContext` (7 fields), `base`, and `delivery`. Switching from turn hooks to agent hooks for inbound queue delivery in `step.ts:401` requires cloning a whole `WriteContext` bag (`const delivery = { ...write, hooks: inbound }`).
- **Proposed restructuring:**
  1. Promote `CurrentHookCall` to a `Context.Reference<HookCall | undefined>("spindle/CurrentHookCall", { defaultValue: () => undefined })`, set via `Context.add` alongside `WritingHandle` in `makeThreadState` (`thread-state.ts:192`). `depthOf` in `messages.ts:32` reads `yield* CurrentHookCall`, dropping `call` from `WriteContext`.
  2. Optionally promote `ActiveHooks` to a `Context.Service<ActiveHooks, HookScope>()("spindle/ActiveHooks")`, provided once around the execution loop and overridden on inbound drain with `Effect.provideService(ActiveHooks, inbound)` — dropping `hooks` from `WriteContext` and deleting `delivery`.
- **Line estimate:** `-25` to `-35` net lines across `hooks.ts`, `messages.ts`, `thread-state.ts`, `step.ts`, and `trigger.ts`.
- **Risk & guarding tests:** Low risk; `thread-state.ts:192` already uses `Context.add` + `Effect.runPromiseWith(services)` for `WritingHandle`. Guarded by `H8`, `H9`, `H15b`, `H15c`, `I9`, and `history.test.ts:217-236` (which would provide `ActiveHooks` instead of passing `hooks` in `write`).
- **PR & ripple:** Carry in **PR 7** (`m1/5-hooks`), simplifies PR 8 (`m1/6-queue` `delivery` and `WritingHandle` wiring).
- **Effect API verification:** Verified `Context.Reference` (`Context.d.ts:1741`), `Context.Service` (`Context.d.ts:196`), `Context.add` (`Context.d.ts`), and `Effect.provideService` (`Effect.d.ts:12665`) in `node_modules/effect/dist`.

---

### E4. Manual clock subtraction, mutable variables, and `Effect.runSyncWith` in `hooks.ts`, `history.ts`, and `thread-state.ts`

- **Location:** `packages/runtime/src/execution/hooks.ts:482-498`, `packages/runtime/src/execution/history.ts:30-53`, `packages/runtime/src/execution/thread-state.ts:170-183,217-221`
- **Cost to maintainers:**
  - `hooks.ts:482-498` manually reads `Clock.currentTimeMillis` before and after `callHook`, mutates `call.expired`, and unpacks nested `_tag` unions (`outcome._tag === "Success" && outcome.success._tag === "None"`).
  - `history.ts:30` stores cache state in a bare `let copy` variable mutated from both an Effect (`read`) and a plain void callback (`inserted`), instead of an Effect `Ref` (`Ref.make` / `Ref.get` / `Ref.set`).
  - `thread-state.ts:217-221` (`readHistory`) duplicates the `expired()` check already wrapped in `check()` (line 180) and calls `Effect.runSyncWith(state.services)(history.read)` — bypassing `services` (which carries `WritingHandle`) and hard-coupling the `execution.messageHistory` getter to a synchronous SQLite driver (any async store driver would throw `AsyncFiberException`).
- **Proposed restructuring:**
  - In `hooks.ts`, wrap `callHook` with `Effect.timed` and compare `Duration.isGreaterThan(elapsed, timeout)` to collapse the manual clock read and nested `_tag` checks into one flat classification step.
  - In `history.ts`, hold the cache in `Ref.makeUnsafe<HistoryCache | undefined>(undefined)` (synchronous, so `Effect.runSyncWith` still works while keeping state in Effect's concurrency primitive) and make `inserted` an `Effect.Effect<void>` yielded by `messages.ts:205`.
  - In `thread-state.ts:217-221`, reuse `check()` instead of repeating `const refused = expired(); if (refused !== undefined) throw refused` (and note the sync-store coupling of the spec's synchronous `execution.messageHistory` getter as an explicit architectural constraint).
- **Line estimate:** `-10` to `-15` lines in `hooks.ts` and `thread-state.ts`; `+3` lines in `history.ts`.
- **Risk & guarding tests:** Low risk; `Effect.timed` reads `Clock.currentTimeNanos` before and after the effect, preserving synchronous-blocking timeout detection (`H15b`). Guarded by `H15`, `H15b`, `M8`–`M8d`, and `test/execution/history.test.ts`.
- **PR & ripple:** Carry in **PR 7** (`m1/5-hooks`); minor rebase in PR 8 (`history.ts:48`).
- **Effect API verification:** Verified `Effect.timed` (`Effect.d.ts:8972`), `Duration.isGreaterThan` (`Duration.d.ts:1673`), and `Ref.makeUnsafe` / `Ref.get` / `Ref.set` / `Ref.update` (`Ref.d.ts:127,181,217,603`) in `node_modules/effect/dist`.

---

### E5. `assemble.ts` returns a union `Effect.Effect<void> | SetupError` instead of `Effect.Effect<void, SetupError>`

- **Location:** `packages/runtime/src/execution/assemble.ts:96-111`
- **Cost to maintainers:** `checkSystemPrompt` and `checkSystemMessages` return `holdsSecret(...) ? new SetupError(...) : Effect.void`. While `Data.TaggedError` is yieldable inside `Effect.gen`, returning the raw error produces the union type `Effect.Effect<void, never, never> | SetupError` rather than `Effect.Effect<void, SetupError>`, which prevents direct `.pipe(...)` composition with Effect combinators.
- **Proposed restructuring:** Return `Effect.fail(new SetupError(...))` in the truthy branch (or `Effect.when(Effect.fail(...), () => holdsSecret(...))`) so both functions have the uniform return type `Effect.Effect<void, SetupError>`.
- **Line estimate:** `0` net lines.
- **Risk & guarding tests:** Zero risk; guarded by `H22`, `H22d`, `I6`.
- **PR & ripple:** **PR 7** (`m1/5-hooks`). No ripple.
- **Effect API verification:** Verified `Effect.fail` and `Data.TaggedError` (`Data.d.ts:798`) in `node_modules/effect/dist`.

---

### E6. Confirmed `@effect/tsgo` default-rule diagnostics on PR 7's files

All diagnostics below were confirmed by reading the code at `43a4d5b` and running `@effect/tsgo@0.73.7` in scratch.

- **`tryCatchInEffectGen` (`TS377012`):**
  - `packages/runtime/src/execution/hooks.ts:501` (**PR 7**): `try { next = row.accept(...) } catch { next = INVALID }` inside `Effect.gen`. Eliminated by S1/S4 (`Effect.try` + `Schema.decodeUnknownOption`).
  - `packages/runtime/src/execution/tools.ts:130` (**PR 6**, file touched by PR 7): `try { result = fieldsOf(returned.success) } catch` inside `Effect.gen`. Replace with `Effect.try` or reuse a typed `readResult` returning `Result.Result`.
- **`effectSucceedWithUndefined` (`TS377162`):**
  - `packages/runtime/src/execution/hooks.ts:472` (**PR 7**): `options.check ?? (() => Effect.succeed(undefined))`. Replace with `Effect.undefined` (`Effect.d.ts:1747`) or branch on `options.check !== undefined`.
- **`unknownInEffectCatch` (`TS377021`) & `TS377030` (unknown in error channel):**
  - `packages/runtime/src/execution/tools.ts:104,120` (**PR 6**, file touched by PR 7) and `packages/runtime/src/execution/call.ts:372` (**PR 6**, file touched by PR 7): `Effect.tryPromise({ ..., catch: (cause) => cause })` leaves `E = unknown`. Map `cause` to a tagged error (or directly to the formatted error string in `catch`).
  - `packages/runtime/src/execution/thread-state.ts:284,335,346,382` and `packages/runtime/src/execution/trigger.ts:74` (**PR 8**): `ThreadControl` and `ThreadSupervisor.send` declare `unknown` in the error channel; narrow those to their concrete tagged error unions in PR 8.
- **`globalErrorInEffectFailure` (`TS377023`):**
  - `packages/runtime/src/execution/thread-state.ts:226,303` (**PR 6**, file touched by PR 7): `Effect.fail(new Error(...))` in `load()` and `env()`. Replace with `Data.TaggedError` (`DefinitionNotFound`, `MissingEnvVar`) — since `Data.TaggedError` extends `YieldableError` (an `Error` subclass, verified in `Data.d.ts:798`), Promise callers catching `Error` see the exact same `.message`.
- **Line estimate:** `-5` to `+10` net lines across `hooks.ts`, `tools.ts`, `call.ts`, `thread-state.ts`.
- **PR & ripple:** Carry `hooks.ts:472,501` in **PR 7**; carry `tools.ts:104,120,130`, `call.ts:372`, `thread-state.ts:226,303` in **PR 6**; carry `ThreadControl`/`send` error narrowing in **PR 8**.

---

### E7. Confirmed `@effect/tsgo` expanded-rule diagnostics on PR 7's files

Running `@effect/tsgo@0.73.7` in scratch with additional rules enabled surfaced five relevant rule groups in PR 7's files (excluding noisy stylistic/v4-unstable rules):

- **`missingConcurrencyOption`:**
  - `packages/runtime/src/execution/step.ts:449` (**PR 7**): `Effect.forEach(calls, ..., { discard: true })` in `streamed.abandoned`. Pass `{ discard: true, concurrency: 1 }` so sequential hook order is explicit.
  - `packages/runtime/src/execution/step.ts:309` (**PR 6**, touched by PR 7): `Effect.forEach(pending, Fiber.join, { discard: true })` joins independent `getResponseMetadata` fibers sequentially; `{ discard: true, concurrency: "unbounded" }` makes the independent join explicit (verified `Concurrency = number | "unbounded"` in `Types.d.ts:448` and `Effect.forEach` options in `Effect.d.ts:1091`).
- **`globalJsonInEffect` / `preferSchemaOverJson`:**
  - `packages/runtime/src/execution/messages.ts:166,168,169` (**PR 8** on PR 7's `messages.ts`): raw `JSON.parse`/`JSON.stringify` inside `Effect.gen` to re-redact queued tool arguments — disappears under S2 when `step.ts` formats the finalized arguments once.
  - `packages/runtime/src/execution/assemble.ts:24,305,333` and `packages/runtime/src/execution/hooks.ts:68,85,148` (**PR 7**): raw `JSON.parse` inside `metadataOf`, `parses`, `callFrom`; replaced by `Schema.fromJsonString` under S4.
- **`yieldInCallArgument`:**
  - `packages/runtime/src/execution/messages.ts:151` (**PR 7**): `messageOf(draft, crypto.randomUUID(), yield* nowMicros)`.
  - `packages/runtime/src/execution/trigger.ts:55` (**PR 7**): `atRest(yield* store.getThread(threadId), { learn: true })`.
  - `packages/runtime/src/execution/step.ts:608,681` (**PR 7 / PR 8**): `pastOf(yield* history.read, ...)` and `results.push(yield* runCall(...))`.
  - Binding each `yield*` to a `const` first separates effect execution from call construction.
- **`cryptoRandomUUID` / `cryptoRandomUUIDInEffect`:**
  - `packages/runtime/src/execution/messages.ts:151,199` (**PR 7**) and `packages/runtime/src/execution/step.ts:518` (**PR 8**). Acceptable on Node 22 + Bun; only worth swapping if deterministic ID generation is wanted in tests.
- **`apiStabilityLeak`:**
  - `packages/runtime/src/execution/history.ts:22`, `step.ts:254`, `trigger.ts:52,59`: expose `SqlError` (marked unstable in Effect 4.1.5) in public signatures. Expected across the repo today unless `ThreadStore` wraps `SqlError` in a domain `StoreError` (PR 4 decision).

---

## 4. Duplication with Code from Other Pull Requests

- **`isRecord` defined locally 13 times** across `packages/runtime/src/`: PR 7 added copies in `hooks.ts:59` and `messages.ts:47`, alongside existing copies in `assemble.ts:19`, `tools.ts:27`, `call.ts:27`, `thread-state.ts:86`, `turn.ts:53`, `ThreadSupervisor.ts:65`, `store/schema.ts:182`, `registry/validate.ts:64`, `registry/load-packages.ts:18`, `providers/config.ts:14`, and `providers/openai-compatible.ts:29`. One shared helper (or `Predicate.isObject` / `Schema`) replaces all 13.
- **`isCount` defined locally 4 times:** `hooks.ts:107` (PR 7), `store/schema.ts:215` (PR 4/PR 8), `store/sqlite.ts:98` (PR 4), and `ThreadSupervisor.ts:68` (PR 8).
- **`isAttachmentRef` duplicated with a weaker contract:** `tools.ts:81-82` (PR 6, left behind in PR 7) checks only `type`/`id`/`path`, contradicting canonical `store/schema.ts:217-227` (which PR 7 originally wrote in `hooks.ts` and PR 8 moved to `store/schema.ts` for `hooks.ts` and `ThreadSupervisor.ts`).
- **`nowMicros` duplicated:** `messages.ts:45` (PR 7) duplicates `store/sqlite.ts:85` (PR 4).
- **At-rest `HookScope` + `noInvoke` duplicated:** `trigger.ts:14-49` (PR 7) and `step.ts:362-366,385-401` (PR 7 / PR 8) both construct an agent-scoped, `execution: undefined` `HookScope` with the identical `noInvoke` error message.
- **`parseJson` / `parses` duplicated:** `step.ts:111` (PR 6), `assemble.ts:22` (PR 6/PR 7), and `hooks.ts:146` (PR 7).
- **`readResult` / `isToolResult` (`tools.ts:57-79,143-150`) overlapping `acceptResult` (`hooks.ts:260-270`):** both validate `ToolResult` shapes in slightly different ways.
- **Test helpers duplicated in conformance scenarios:** `settle` at `scenarios/hooks.ts:312` and `454`; `noop` at `scenarios/hooks.ts:18` and `scenarios/messages.ts:22`.

---

## 5. What Is Good and Should Not Be Touched

- **Revision-based history cache (`store/migrations/0002_revision.ts` + `execution/history.ts`):** Raising `threads.revision` via three SQLite `AFTER` triggers inside the write transaction, returning `revision: null` when `Effect.serviceOption(sql.transactionService)` is `Some`, and caching only committed revisions cleanly preserves live cross-handle visibility (`M8`–`M8d`, `history.test.ts`) without paying a full-table read per step. Keep this design.
- **`Context.Reference` for `HookTimeout` and `NestedWriteLimit` (`hooks.ts:17,23`):** Idiomatic Effect v4 configuration with sensible defaults and clean CLI override via `Effect.provideService` (`cli/run.ts:244`).
- **Single-pass streaming progress parser (`call.ts:143-218`, `argumentWatcher`):** Compact, zero-dependency, `O(1)` per character, and directly unit-tested in `test/execution/hooks.test.ts:19-42`.
- **Single write boundary and post-hook redaction order (`messages.ts`):** Routing every create and update through `messages.ts`, redacting *after* `before_create_message`/`before_update_message` so secrets learned during hooks are redacted (`H22b`, `H22c`), and retrying an ID collision once without re-running hooks (`I2`) are all sound invariants. Keep them while refactoring the `Writer` switch (S2).
- **Secret-safe hook warnings and post-hook system checks (`hooks.ts:515`, `assemble.ts:96,105`):** Logging only hook id, position, and problem (never thrown error text or arguments, `H15`) and checking system prompts and injected system messages after request hooks (`H22`, `H22d`, `I6`) protect against leaks cleanly.
- **`copyMessage` (`history.ts:16-17`):** Preserves `"__proto__"` as an own key via `Object.fromEntries` (`history.test.ts:298-308`) and avoids Bun's slow `structuredClone` path.

---

## 6. What Could Not Be Judged and Why

- **Performance impact of Effect `Schema` decoding on long histories:** `Schema` correctness on sparse arrays, `SafeInt`, `Json`, `Date`, `toJSON`, and throwing getters was verified in Node against `effect@4.1.5`, but the 200-step and 5,000-message benchmarks (`bench_hooks`, `step-probe.ts`) were not run on a rewritten `hooks.ts` under Node 22 and Bun 1.4.5. If `Schema` decoding of `Message[]` in `filter_messages` turns out to be materially slower than `isMessage` at 5,000 messages, the `Schema` boundary can still be used for `before_create_message`, `before_update_message`, `prefilter_llm_history`, and tool results while keeping a compiled fast-path or reusing `Schema.is` for `filter_messages`.
- **Future Milestone 2–7 hook positions:** Only the 13 M1 positions were implemented. M3's `after_subagent_created` passes a second `ThreadState` (`childState`), which cannot be `structuredClone`d; S1's per-position typed argument specs avoid that trap, whereas the current blind `lead.map(structuredClone)` in `hooks.ts:478` would break on it.
- **Open behavioral questions outside scope:** `docs/design/user-code-at-the-edge.md` and `docs/design/message-invariants.md` leave several behavioral questions open for the operator (e.g., whether `skipped` tool calls should silently revert hook edits in `before_create_message` or skip those hooks, whether abandoned streamed calls should emit `tool_call_done`, and whether create hooks may edit `parent_id`). All restructurings above preserve current settled behavior; changing any of those policies requires an operator decision.
