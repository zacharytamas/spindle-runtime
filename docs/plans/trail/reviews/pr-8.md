# Code Quality Review — PR 8 (`m1/6-queue`)

**PR:** `zacharytamas/spindle-runtime` PR 8 — "Queues, one execution per thread, recovery, stop, terminate"
**Commits:** base `origin/m1/5-hooks` (`7d27f41`), head `origin/m1/6-queue` (`6d5a778`), verified at top of stack `origin/m1/7-chat` (`43a4d5b`)
**Effect version verified against:** `effect@4.1.5` (`node_modules/effect/dist/*.d.ts` and `internal/effect.js`), checked with `@effect/tsgo@0.73.7` in an isolated scratch checkout at `43a4d5b`.

---

## 1. Verdict

**Would not pass the approval bar.** Behavior is well-tested and the core ownership invariants hold, but three rounds of audit fixes turned execution lifecycle management into a tangle of incidental complexity: an execution's life is split across a 9-field mutable `Run` bag, a 4-field `Live` record, two coupled finalizers in two files (`step.ts` and `ThreadSupervisor.ts`), five manual `releaseWait.abort()` sites, and four separate "did this run lose its thread?" checks that re-query SQLite for facts `store.settle` and `FlowEnded` already had. On top of that, `step.ts` grew into a 778-line file dominated by one 525-line `Effect.gen` closure, the step loop runs under fiber-wide `Scheduler.PreventSchedulerYield = true` where a `settlement === "continue"` branch can spin without yielding, `ThreadSupervisor` and `ThreadControl` erase all typed errors to `unknown`, and PR 8 added two conformance files over the 1,000-line ceiling (`queue.ts` at 1,932 lines, `ownership.ts` at 1,033 lines). The single largest thing wrong is the absence of one unified `Execution` lifecycle state machine owning claim, stop, abort hold, settlement, and release.

---

## 2. Structural Findings

### S1. Execution lifecycle is fragmented across mutable flags, two coupled finalizers, five wait-release sites, and four "lost thread" decisions

- **Locations at `origin/m1/7-chat`:**
  - `Run` bag: `packages/runtime/src/execution/thread-state.ts:30-42`
  - `Live`, `start` exit handler (4 jobs), 5 `releaseWait.abort()` sites, 2 `displaced` checks: `packages/runtime/src/execution/ThreadSupervisor.ts:35-40`, `135-195`, `250-253`, `293-298`, `302-309`, `313-322`
  - `release`, `ended`, `FlowEnded` catch, `onInterrupt`, `ensuring`: `packages/runtime/src/execution/step.ts:294-344`, `710-776`
  - `Settlement` discarding `terminated_at`: `packages/runtime/src/store/ThreadStore.ts:150`, `packages/runtime/src/store/sqlite.ts:570-594`
- **Confirmation of prior audit (all four items confirmed, plus two more found):**
  1. **"This run lost its thread" is decided in four places** (and re-read in a fifth): `ThreadSupervisor.ts:144` (`start` displacement), `ThreadSupervisor.ts:295` (`tick` polling `getThread`), `step.ts:338-340` (`ended` polling `getThread`), and `step.ts:765` (`onInterrupt` polling `getThread`), then re-combined with yet another `store.getThread` at `ThreadSupervisor.ts:163-170`. Worse, `FlowEnded` already carries `why: "terminated" | "superseded"` computed atomically inside SQLite (`ThreadStore.ts:121`), yet `step.ts:738-742` throws away `error.why` and calls `ended("superseded", ...)` to re-query the database; and `sqlite.ts:573-574` already reads `row.terminated_at` inside `store.settle`, then throws it away by collapsing both cases into `"superseded"`.
  2. **`Run` is eight mutable signals** shared bidirectionally between `ThreadSupervisor.ts`, `step.ts`, `thread-state.ts`, `hooks.ts`, `tools.ts`, and `callback.ts`: `pending`, `releaseWait`, `waitForCallbacks`, `displaced`, `resumeQueued`, `abort`, `stop`, `ended` (plus `steps`, duplicating `execution.stepCount` at `step.ts:353,663-665`).
  3. **The `onExit` handler of `start` (`ThreadSupervisor.ts:154-189`) does four jobs** (cleanup `flows`/`live`, reconstruct interrupted outcome via `store.getThread`, claim/spawn a successor execution if `run.resumeQueued && !closing`, and complete `entry.done`) and communicates with `step.ts`'s `onInterrupt` (`step.ts:749-771`) solely by mutating `run.displaced`, `run.resumeQueued`, `run.steps`, and `run.ended`. That split is also why `ThreadSupervisor.ts:193` must pass `{ uninterruptible: true }` while `step.ts:716` re-enables `Effect.interruptible`.
  4. **`releaseWait.abort()` is called from five sites**: `ThreadSupervisor.ts:145` (`start`), `251` (`terminate`), `296` (`tick`), `304` (shutdown finalizer), and `319` (`abortExecution(..., true)`).
  5. **Extra finding — accidental double `store.settle` on settlement failure (`Q35`):** In `step.ts:717-745`, when `store.settle` throws `SqlError` inside `loop`, `catchCause`'s `default:` branch catches `SqlError` and calls `fail("step_error", ...)` which calls `store.settle` a *second* time; Q35 only passes because the test trigger breaks the second `settle` too.
- **Why it costs maintainers:** Any change to abort, terminate, recovery, or shutdown forces edits across four files and reasoning about interleavings of six boolean flags and two separate finalizers. A single forgotten `releaseWait.abort()` hangs abort cleanup indefinitely; a single stale `getThread` read misreports `execution_lost` as `idle`.
- **Proposed restructuring (the unified `Execution` lifecycle model):**

  **Step 1 — Have `store.settle` return the fact SQLite already read.**
  In `ThreadStore.ts:150` and `sqlite.ts:574`:
  ```ts
  export type Settlement = "settled" | "capped" | "continue" | "terminated" | "lost"

  // sqlite.ts:574 (inside the settle transaction, where `row` already has `terminated_at`):
  if (row === undefined || row.flow_id !== flowId || row.run_state !== "running")
    return row?.terminated_at != null ? "terminated" : "lost"
  ```
  This eliminates every post-settlement `store.getThread` call (`step.ts:338`, `step.ts:765`, `ThreadSupervisor.ts:163`, `ThreadSupervisor.ts:295`) and closes the TOCTOU window where a successor changes `status` before the old execution reads it.

  **Step 2 — Introduce one `Execution` state machine (`packages/runtime/src/execution/execution.ts`) that owns `Phase`, `CallbackTracker`, `Latch`, `AbortController`, `Deferred`, and the single `finalize` handler.**
  ```ts
  export type StopRequest = { readonly by?: Side; readonly reason: "aborted" | "aborted_by_user" }

  type Phase =
    | { readonly _tag: "Running"; readonly stop?: StopRequest }
    | { readonly _tag: "Aborting"; readonly reason: string; readonly holdCallbacks: boolean }
    | { readonly _tag: "Ended" }

  // "hold" = user abort while process stays alive (O06, O21, O22, chat 2nd Ctrl-C)
  // "drop" = terminate, forced recovery / tick displacement, local start displacement, exiting abort, shutdown
  type CancelMode = "hold" | "drop"

  export interface Execution {
    readonly threadId: string
    readonly flowId: string
    readonly abortSignal: AbortSignal
    readonly done: Deferred.Deferred<RunOutcome, ExecutionInfraError>
    readonly callbacks: CallbackTracker // track(op, fn) -> Promise, firstPending(), awaitAllOr(latch)
    readonly phase: () => Phase
    readonly stopRequest: () => StopRequest | undefined
    readonly requestStop: (req: StopRequest) => boolean // only transitions Running -> Running(stop ??= req)
    readonly cancel: (mode: CancelMode) => boolean      // single transition + abort + Latch.openUnsafe + interrupt
    readonly abortedOperation: () => string | undefined // for chat's onWaiting
    readonly recordStep: () => number
    readonly steps: () => number
    readonly markEnded: () => void
    readonly isRevoked: () => boolean                   // phase._tag !== "Running"
  }
  ```
  Every control path collapses into ONE `cancel(mode)` method:
  - `cancel(mode)` transitions `Running -> Aborting(reason, holdCallbacks: mode === "hold")`, or narrows `Aborting(holdCallbacks: true) -> Aborting(holdCallbacks: false)` when `"drop"` arrives later.
  - Inside `cancel(mode)` — and nowhere else — it fires `abort.abort()`, opens `releaseHold.openUnsafe()` whenever `!holdCallbacks` (collapsing all 5 `releaseWait.abort()` sites into 1 line!), and calls `fiber?.interruptUnsafe()`.
  - All 5 external callers simplify to one call:
    - `supervisor.abortExecution(id, exiting)` -> `exec.cancel(exiting ? "drop" : "hold")`
    - `supervisor.terminate(id)` -> after `store.terminate(id)`, `local.cancel("drop")`
    - `supervisor.tick` (`owned.get(id) !== flowId`) -> `entry.cancel("drop")` (no `getThread` needed!)
    - `supervisor.start` (local displacement) -> `previous.cancel("drop")`
    - `supervisor` shutdown finalizer -> `closing = true; for (const e of live.values()) e.cancel("drop")`
  - **One finalizer** (in `supervisor.start` wrapping `Effect.interruptible(runStepLoop(exec, ...))`, still forked `{ uninterruptible: true }` so same-turn abort in O21 always enters it):
    1. `Exit.isSuccess(exit)`: `exec.markEnded()`, remove `flowId` from `flows` and `entry` from `live`, `Deferred.succeed(done, exit.value)`. (In `step.ts`, `FlowEnded` uses `error.why` directly instead of re-querying `getThread`, and `SqlError` from `store.settle` is NOT caught by `catchCause` so it goes directly to step 2.)
    2. `Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)`: `exec.markEnded()`, remove from `flows`/`live`, `Deferred.failCause(done, exit.cause)`.
    3. `Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)`:
       - Ensure `exec.cancel("drop")` if interrupted directly by scope without `cancel`.
       - If `phase._tag === "Aborting" && phase.holdCallbacks`: wait via `Effect.raceFirst(exec.callbacks.awaitAll, releaseHold.await)`.
       - Re-read `phase` (a `"drop"` during the wait may have flipped `holdCallbacks` to `false`).
       - Settle once: `const settlement = yield* store.settle(threadId, flowId, { state: "idle", reason }, { continueIfQueued: false, closing: CLOSING.aborted })` (on `SqlError`, clean up and `Deferred.failCause(done, cause)`).
       - Map `settlement` directly to `RunOutcome` — no `getThread`:
         - `"settled"` -> `{ status: "idle", reason }`
         - `"terminated"` -> `{ status: "idle", reason: "aborted" }`
         - `"lost"` -> `{ status: "failed", reason: "execution_lost" }`
       - `exec.markEnded()`, remove from `flows`/`live`.
       - If `settlement === "settled" && phase._tag === "Aborting" && phase.holdCallbacks && !closing`, claim and start `entry.successor`.
       - `Deferred.succeed(done, outcome)`.

  **Verification against `ownership.ts`, `queue.ts`, and `cli/chat.ts`:**
  - **O01, O03, O14, O16, Q39, `cli/ownership.test.ts` (forced recovery):** `tick` calls `cancel("drop")`, waking any hold immediately; `store.settle` sees `row.flow_id !== flowId && row.terminated_at === null` and returns `"lost"` -> `{ status: "failed", reason: "execution_lost" }`. If the loop instead hits `FlowEnded({ why: "superseded" })`, `step.ts` uses `error.why` directly without re-querying.
  - **O04, O07, Q13, Q16, Q34 (`terminate`):** `store.terminate` sets `terminated_at` and settles `idle/aborted` atomically. `cancel("drop")` skips callback wait; `store.settle` sees `row.terminated_at !== null` and returns `"terminated"` -> `{ status: "idle", reason: "aborted" }`, no successor.
  - **O06 (abort hold + queued send `"B"`):** `cancel("hold")` fires `abort.abort()` (revoking handles immediately via `isRevoked()`), holds claim until `stubborn` settles, then `store.settle` returns `"settled"`, `holdCallbacks && !closing` is true so `entry.successor` claims and runs `"B"` strictly after `stubborn` returns.
  - **O21 (same-turn abort after `send` or `queueMessage`):** `{ uninterruptible: true }` on `forkIn` guarantees the single `onExit` finalizer installs before `Effect.interruptible(runStepLoop)`; `cancel("hold")` settles `"settled"` with `"aborted_by_user"` and resumes queued `"A"` in `entry.successor`.
  - **O22 (timed-out hook before abort):** `CallbackTracker.expire(handle)` removes the timed-out promise from the active map on timeout (same as `hooks.ts:488`), so `callbacks.awaitAll` finishes immediately.
  - **Q11, Q12, Q18–Q21 (`stop`):** `requestStop` updates `Running.stop` without firing `abortSignal`; loop settles with `continueIfQueued: false`.
  - **Q35 (`breakSettlement`):** `store.settle` failure exits via branch 2 without a redundant second `store.settle` attempt, rejecting `done` with `SqlError`.
  - **`cli/chat.ts:218-273`:** `supervisor.abortExecution` still returns `entry.done` (the aborted execution's `Deferred`, not `successor`), and `abortedOperation()` feeds `onWaiting`.
- **Line estimate:** Adds `execution.ts` (~120 lines); removes `callback.ts` (31 lines), `Run` in `thread-state.ts` (~15 lines), ~85 lines from `ThreadSupervisor.ts`, and ~75 lines from `step.ts` (net **~85 lines removed**, and eliminates 6 mutable flags, 4 DB re-queries, and 4 duplicate release sites).
- **Risk and guarding tests:** Medium risk around microtask ordering of same-turn abort and remote termination. Guarded by `ownership.ts` (O01–O23), `queue.ts` (Q03–Q43), `test/cli/ownership.test.ts`, `test/cli/queue.test.ts`, `test/cli/chat-interrupt.test.ts`, and `test/store/claims.test.ts` (update 2 `claims.test.ts` assertions expecting `"superseded"` -> `"lost"` / `"terminated"`).
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Ripples lightly into **PR 10 (`m1/7-chat`)** only where `ThreadSupervisor.ts` was edited (`abortedOperation` / `abortExecution`), with zero changes to `cli/chat.ts` itself.
- **Effect APIs verified:** `Latch.makeUnsafe`, `Latch.openUnsafe`, `Latch.await` (`node_modules/effect/dist/Latch.d.ts`); `Deferred.make`, `Deferred.succeed`, `Deferred.failCause` (`Deferred.d.ts`); `Effect.raceFirst`, `Effect.onExit`, `Effect.forkIn`, `Effect.interruptible` (`Effect.d.ts`).

---

### S2. `step.ts` (778 lines) packs 525 lines into one closure, duplicates queued-call redaction (with a latent hook leak) and tool stop checks, and bolts special cases onto `messages.ts`

- **Locations at `origin/m1/7-chat`:**
  - `runExecution`: `packages/runtime/src/execution/step.ts:254-778` (525 lines)
  - Double queued-argument redaction + stale `argumentsText` to `tool_call_started`: `packages/runtime/src/execution/step.ts:516, 541` and `packages/runtime/src/execution/messages.ts:165-170`
  - Double/triple stop check + pointer-identity `notRun` sentinel: `packages/runtime/src/execution/step.ts:468-469, 679`, `packages/runtime/src/execution/tools.ts:42-45, 118`
  - Special-case `writer === "queued"` and `writer === "skipped"` branches bolted onto `createMessage`: `packages/runtime/src/execution/messages.ts:92-100, 165-179`
  - Duplicated `noInvoke` helper: `packages/runtime/src/execution/step.ts:362-366` and `packages/runtime/src/execution/trigger.ts:38-42`
- **Confirmation of prior audit:** Confirmed both halves.
  1. Queued-call arguments are redacted in `step.ts:516`, serialized into `tool_calls` JSON, then parsed *twice* (`JSON.parse(original.tool_calls)` and `JSON.parse(call.function.arguments)`), redacted a *second* time, and re-serialized twice in `messages.ts:165-170`. Worse, `step.ts:541` passes the pre-`createMessage` `argumentsText` to `tool_call_started`, so if a `before_create_message` hook resolves a new secret via `state.env()`, `messages.ts:168` redacts the stored record while `tool_call_started` still receives the unredacted argument string.
  2. Stopping a tool call is checked at `step.ts:679` (for the trace), checked again at `step.ts:468` inside `runCall`, and checked a third time at `tools.ts:118` after `schema.safeParseAsync` — communicating "skipped" back to `step.ts:469` via object reference equality (`returned === notRun`) on a frozen singleton (`tools.ts:42`). If stop arrives during `safeParseAsync`, the trace at `step.ts:680` already logged the call without `" not run"`.
- **Why it costs maintainers:** Reading `runExecution` requires holding 15 closed-over mutable variables and 9 nested closures in mind at once. Meanwhile, `createMessage` has accumulated ad-hoc post-hook patches (`if (writer === "queued")`, `if (writer === "skipped")`) that obscure what `WRITTEN[writer]` actually means.
- **Proposed restructuring:**
  1. Remove pre-redaction at `step.ts:516` (pass `JSON.stringify(entry.args)`, matching how `injection` and `result` already pass unredacted drafts to `before_create_message` and redact once right before insert per `messages.ts:140`). Fold `tool_calls` argument redaction into `redactField` for `writer === "queued"` (one helper, one place), and pass the stored `message`'s redacted arguments to `tool_call_started` at `step.ts:541`. (Verified against Q30 and Q31: neither expects redaction before `before_create_message`.)
  2. Have `executeTool` return a discriminated outcome (`{ _tag: "Skipped" } | { _tag: "Ran"; result: ToolResult }`, with `invokeTool` mapping `"Skipped"` to `notRun`), move `record("tools", ...)` into `runCall`, and delete the duplicate check at `step.ts:679` and the pointer-equality check `returned === notRun` at `step.ts:469`.
  3. Extract pure helpers (`redactError`, `redactLog`, `makeThreadState` wiring / `noInvoke`) out of `runExecution`, move queued-tool resolution (`runQueuedTool` + `drain`) into a small `packages/runtime/src/execution/drain.ts` (~85 lines), and combine with S1 (`execution.ts`). That cuts `runExecution` from 525 lines to ~190 lines and `step.ts` from 778 lines to ~420 lines.
- **Line estimate:** Moves ~150 lines into `drain.ts` and `execution.ts`; deletes ~35 lines of duplicated redaction, double checks, and `noInvoke` duplication.
- **Risk and guarding tests:** Low-to-medium risk; guarded by `queue.ts` (Q08, Q09, Q11, Q12, Q18–Q22, Q30–Q32, Q40) and `hooks.ts` / `messages.ts` conformance scenarios.
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Minimal ripple to PR 10 (`step.ts` only had a 2-line diff in PR 10).
- **Effect APIs verified:** Standard `Effect.fn` / `Effect.gen` (`Effect.d.ts`).

---

### S3. Fiber-wide `Scheduler.PreventSchedulerYield = true` lets `settlement === "continue"` spin without yielding

- **Locations at `origin/m1/7-chat`:**
  - `packages/runtime/src/execution/ThreadSupervisor.ts:153` (`Effect.provideService(Scheduler.PreventSchedulerYield, true)`)
  - `packages/runtime/src/execution/step.ts:594-606` (`if (settlement === "continue") continue`) and `700-704`
  - `packages/runtime/src/store/sqlite.ts:70-83` (`unyielding` wrapper already protecting every store method)
- **Confirmation of prior audit:** Confirmed — and verified directly in `effect@4.1.5`'s fiber runtime (`node_modules/effect/dist/internal/effect.js:489, 781-788`). `PreventSchedulerYield = true` disables Effect's automatic `shouldYield` check completely, while explicit `Effect.yieldNow` still yields. Because `ThreadSupervisor.ts:153` turns off automatic yielding for the *entire* execution fiber (not just SQLite calls, which `sqlite.ts:70-83` already guard), any tight `continue` path with synchronous SQLite and no async hook — e.g. `drain` returning `count === 0` or only same-side messages (`!prompted`, so `steps` never increments toward `stepCap`) while `store.settle` returns `"continue"` — spins synchronously without yielding to `tick`, `abort`, or any other fiber in the process.
- **Why it costs maintainers:** A subtle starvation/livelock hazard where adding a synchronous `observe` callback, a same-side message hook, or a non-SQLite `ThreadStore` can freeze the entire Node/Bun event loop so even Ctrl-C / `tick` cannot interrupt it.
- **Proposed restructuring:**
  1. Remove `Effect.provideService(Scheduler.PreventSchedulerYield, true)` from `ThreadSupervisor.ts:153`; keep `unyielding` solely inside `sqlite.ts:70-83` where it actually protects the single SQLite connection for synchronous `queueTool` calls.
  2. Before `continue` at `step.ts:604` (and `step.ts:703`), `yield* Effect.yieldNow`. In addition, if `turnStart && !prompted && count === 0 && settlement === "continue"`, yielding guarantees `tick` and concurrent fibers run before retrying `drain`.
- **Line estimate:** +2 / -1 lines.
- **Risk and guarding tests:** Very low risk. `claims.test.ts:400` ("a store call never yields to another fiber while it holds the connection") specifically tests `sqlite.ts`'s `unyielding`, not `ThreadSupervisor.ts:153`. Guarded by `claims.test.ts`, `queue.ts`, and `queue-probe.ts bench`.
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Zero ripple to PR 10.
- **Effect APIs verified:** `Scheduler.PreventSchedulerYield` (`node_modules/effect/dist/Scheduler.d.ts:202`, `internal/effect.js:489`) and `Effect.yieldNow` (`Effect.d.ts`, `internal/effect.js:781-788`).

---

### S4. Two conformance files cross 1,000 lines (`queue.ts` at 1,932 lines; `ownership.ts` at 1,033 lines) with out-of-order cases and duplicated polling helpers

- **Locations at `origin/m1/7-chat`:**
  - `packages/conformance/src/scenarios/queue.ts:1-1932` (39 scenarios, Q03–Q43 in non-sequential order: Q43 at line 1188, Q41 at 1322, Q42 at 1651, Q40 at 1874)
  - `packages/conformance/src/scenarios/ownership.ts:1-1033` (23 scenarios, O01–O23)
  - Copy-pasted 500-iteration polling loops: `ownership.ts:389-393`, `queue.ts:1711-1712`, `queue.ts:1902-1903` (whereas `queue.ts:1208` already uses Vitest's `expect.poll`)
- **Why it costs maintainers:** Finding or modifying a scenario in a 1,932-line file with scrambled numbering slows down every review and fix round, and both files violate the 1,000-line ceiling by a wide margin.
- **Proposed restructuring:** Split `queue.ts` into five thematic scenario modules plus a shared helper module under `packages/conformance/src/scenarios/queue/` (keeping `packages/conformance/src/scenarios/queue.ts` as a 15-line barrel exporting `queueScenarios` so `conformance.test.ts` and `ledger.json` stay untouched):
  - `queue/helpers.ts` (~70 lines): `using`, `echo`, `noop`, `stopOnStart`, `acknowledge`, `shape`, `ref`, `statusOf`, `quiet`, `attempt` (moved out of `ownership.ts` where `queue.ts:15` currently cross-imports it!), and a `waitForQueue` helper using `expect.poll`.
  - `queue/delivery.ts` (~480 lines): **Q03–Q09, Q40** — FIFO admission, multi-send batching, cross-thread concurrency, human-side parking, opening drain window.
  - `queue/validation.ts` (~330 lines): **Q10, Q15, Q26, Q27, Q33, Q37, Q38, Q42** — `uses` targeting, `retries` / null-args validation, atomic getter reads, unreadable / malformed queue entries (`failed_delivery`).
  - `queue/stop.ts` (~540 lines): **Q11, Q12, Q18–Q25, Q43** — cooperative stop boundaries, protected `notRun` receipts, strict `stepCap` and waiting-send successor cap.
  - `queue/termination.ts` (~300 lines): **Q13, Q14, Q16, Q34–Q36, Q39** — terminate at rest / in flight / waiting sends, broken settlement, lost-execution closing receipts.
  - `queue/secrets.ts` (~330 lines): **Q17, Q28–Q32, Q41** — `SecretInArguments` refusal, attachment/message redaction, quoted secrets learned late, ID/name preservation.

  Similarly, split `ownership.ts` (1,033 lines) into two modules under `packages/conformance/src/scenarios/ownership/` with `ownership.ts` as a thin barrel:
  - `ownership/fencing.ts` (~480 lines): **O01–O05, O08–O12** — fenced writes under force-recovery/terminate, clock independence, handle expiry at callback exit and at commit.
  - `ownership/lifecycle.ts` (~490 lines): **O06–O07, O13–O23** — abort callback hold vs immediate terminate, runtime-owned `flow_id`/`caller_seq` recovery & delete guard, terminal external injection exception, same-turn abort, timed-out hook cleanup.
- **Line estimate:** Net ~20 lines removed (deduplicating `using`/`quiet`/`attempt`/polling loops), with every resulting file between 70 and 540 lines.
- **Risk and guarding tests:** Very low risk (pure test-file reorganization; all scenario names and requirement IDs preserved verbatim). Guarded by `pnpm test` and `pnpm ledger`.
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Zero ripple to PR 10 (PR 10 does not edit `queue.ts` or `ownership.ts`).
- **Effect APIs verified:** N/A (Vitest conformance suite).

---

### S5. Global `WeakMap` (`positions`) and throwing `callerSequence` leak row metadata across store, cache, hooks, and assembly

- **Locations at `origin/m1/7-chat`:**
  - `packages/runtime/src/store/ThreadStore.ts:175-185` (`positions = new WeakMap()`, `callerSequence` throwing untyped `new Error(...)`)
  - `packages/runtime/src/store/schema.ts:150-151` (side-effecting `positions.set` inside `toMessage`)
  - `packages/runtime/src/store/sqlite.ts:335-341` (conditional `RETURNING seq` only to feed `positions`)
  - `packages/runtime/src/execution/history.ts:48-49` (manual `WeakMap` propagation on `copyMessage`)
  - `packages/runtime/src/execution/step.ts:625-631` (manual `WeakMap` re-attachment after `filter_messages`)
  - `packages/runtime/src/execution/assemble.ts:189, 248, 269` (reads `positions.get(message)`)
- **Why it costs maintainers:** Object identity is an invisible contract threaded through six files. Any future transformation that spreads or clones a `Message` (like a hook or cache copy) silently loses its `seq`/`callerSeq` unless it remembers to copy the `WeakMap` entry, or throws an untyped runtime `Error` in `callerSequence`.
- **Proposed restructuring:**
  1. Add `readonly seq: number` to `Inserted` (`ThreadStore.ts:65-68`), and always `RETURNING seq` in `sqlite.ts:336` (dropping the conditional branch at `335-338`). Pass `callerSeq: inserted.seq` directly in `step.ts` and `claims.test.ts:57`, deleting `callerSequence` entirely.
  2. Add `readonly positions: ReadonlyMap<string, MessagePosition>` (keyed by `message.id`, which is a unique `PRIMARY KEY`) to `ThreadHistory` (`ThreadStore.ts:71-74`) and `HistoryView` (`assemble.ts:113-122`). Update `history.ts` to keep the `Map<string, MessagePosition>` alongside `messages`.
  3. Delete `positions` (`WeakMap`), `schema.ts:150-151`, `history.ts:48-49`, and `step.ts:625-631` — because keying by `message.id` survives cloning by `filter_messages` automatically.
- **Line estimate:** Removes ~25 lines across 6 files and deletes a module-global mutable `WeakMap` and an untyped `throw new Error`.
- **Risk and guarding tests:** Low risk (`message.id` is `PRIMARY KEY` across all threads, and `step.ts:626` already maps by `m.id`). Guarded by `ownership.ts` (O13–O18), `history.test.ts`, `claims.test.ts`, and `step-loop.ts`.
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Zero ripple to PR 10.
- **Effect APIs verified:** N/A (plain TypeScript data structures).

---

### S6. Split ownership plumbing in `ThreadStore` / `sqlite.ts` duplicates flow checks, adds an ambient-context leak hazard, and repeats SQL reads inside transactions

- **Locations at `origin/m1/7-chat`:**
  - Ambient `WritingHandle` (`Context.Reference`) vs explicit `flowId`: `packages/runtime/src/store/ThreadStore.ts:158-166, 186-188, 202-209, 251, 254-259`
  - Duplicate `flow_id` check in `insertMessage` + `checkHandle`: `packages/runtime/src/store/sqlite.ts:123-128` vs `307-314`
  - Ambient context reset workaround: `packages/runtime/src/execution/ThreadSupervisor.ts:152` (`Effect.provideService(WritingHandle, undefined)`)
  - Redundant `SELECT` queries inside the same transaction: `sqlite.ts:495-496, 503-504` (`requireThread` then `guardWrite` both `SELECT ... FROM threads WHERE id = ?`) and `sqlite.ts:255, 265` (`terminate` calls `selectRun` twice)
- **Why it costs maintainers:** Half of `ThreadStore`'s write methods check ownership via an invisible `Context.Reference` (`WritingHandle`), while `settle` and `nextQueued` take `flowId` explicitly and `insertMessage` checks *both*. Because `Context.Reference` inherits across fibers, any new `forkIn` from a callback that forgets to clear `WritingHandle` (as `ThreadSupervisor.ts:152` had to remember to do) inherits a revoked handle.
- **Proposed restructuring:**
  1. Collapse `requireThread` + `guardWrite` in `sqlite.ts` into a single `guardThread(threadId, injection?)` that runs one `SELECT revision, flow_id, terminated_at FROM threads WHERE id = ${threadId}`, fails with `ThreadNotFound` if absent, and runs `checkHandle` once. Reuse it in `insertMessage`, `updateMessage`, `deleteMessage`, `setValue`, and `terminate` (dropping the duplicate `flow_id` check at `sqlite.ts:307-312` by passing `{ flowId: flowId ?? handle?.flowId, ... }` into one `checkHandle`, and dropping the second `selectRun` in `terminate` at `sqlite.ts:265`).
  2. Longer-term / optional improvement (needs no behavior change): replace ambient `WritingHandle` with an explicit `origin?: WriteOrigin` parameter on fenced store methods (or a dedicated `store.forHandle(owner)` / `store.forFlow(flowId)` scoped view), which eliminates the ambient fiber-inheritance trap at `ThreadSupervisor.ts:152` altogether.
- **Line estimate:** Step 1 removes ~25 lines in `sqlite.ts`. Step 2 adds ~15 lines for `forHandle` and removes `WritingHandle` + `ThreadSupervisor.ts:152` (net ~0 lines, much clearer contract).
- **Risk and guarding tests:** Low risk. Guarded by `ownership.ts` (O01–O20), `claims.test.ts`, `contract.test.ts`, and `unfenced.test.ts`.
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Small ripple into PR 10 if `WritingHandle` is removed (`chat.ts` does not reference `WritingHandle` directly).
- **Effect APIs verified:** `Context.Reference` (`node_modules/effect/dist/Context.d.ts`).

---

### S7. CLI boundary drift (`recoverCommand`, `deliver`, `Platform` interface) and copy-pasted multi-process test harness

- **Locations at `origin/m1/7-chat`:**
  - `packages/runtime/src/cli/status.ts:45-80` (`recoverCommand` omits `path.resolve(db)` and has no `catchCause` boundary, unlike `statusCommand` right above it at lines 10–43)
  - `packages/runtime/src/cli/run.ts:169-178, 197, 229` (`deliver` opens and migrates the SQLite database *twice* on every `spindle send`: once at line 175 just to read `agentId`, and a second time at line 229 when providing `Layer.provideMerge(supervisor, database)`)
  - `packages/runtime/src/platform/Platform.ts:9-25` (`processAlive` is exported by `node.ts:22` and `bun.ts:21` and imported from `#platform` in `sqlite.ts:5`, but missing from `Platform` — defeating the `Implements<typeof BunPlatform>` compile-time parity check!)
  - `packages/runtime/test/cli/queue.test.ts:13-114` vs `packages/runtime/test/cli/processes.ts:9-144` (~100 lines copied verbatim between the two files)
- **Why it costs maintainers:** An unexpected SQLite error in `spindle recover` dumps a raw Effect cause instead of a `spindle:` line; `spindle send` pays double DB open/migration cost; `Platform` fails to check `processAlive` on Bun; and process-spawning test helpers already diverged into two copies inside PR 8 (and a third in PR 10).
- **Proposed restructuring:**
  1. Extract a shared `handleCliErrors(identify)` combinator in `cli/run.ts` (or a small `cli/common.ts`) and apply it to `deliver`, `statusCommand`, `recoverCommand`, and `chatCommand`; add `path.resolve(db)` to `recoverCommand`.
  2. In `deliver`, build one `Layer.memoize` / single `Effect.provide` scope for `database` so `spindle send` opens SQLite once, reads `agentId`, validates, and runs `sendMessage` on the same `ThreadStore` instance.
  3. Add `readonly processAlive: typeof import("./process-alive.ts").processAlive` to `Platform` in `Platform.ts`.
  4. Have `test/cli/queue.test.ts` import `spawn`, `spindle`, `until`, `exists`, `touch`, `entries`, `lines`, `threadIn`, `setup`, `project`, `probe` from `test/cli/processes.ts`, deleting ~95 duplicated lines.
- **Line estimate:** Removes ~110 lines net (mostly in `queue.test.ts` and CLI error handlers).
- **Risk and guarding tests:** Very low risk. Guarded by `test/cli/queue.test.ts`, `test/cli/ownership.test.ts`, `test/cli/run.test.ts`, and `pnpm typecheck`.
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Ripples cleanly into **PR 10 (`m1/7-chat`)**, which can immediately reuse `handleCliErrors` and `loadScript`.
- **Effect APIs verified:** `Layer.provideMerge`, `Effect.provide` (`node_modules/effect/dist/Layer.d.ts`, `Effect.d.ts`).

---

## 3. Effect Practice Findings

### E1. `ThreadSupervisor` and `ThreadControl` erase all typed errors to `unknown` (`anyUnknownInErrorContext` — 24 warnings in PR 8 `src/`)

- **Locations at `origin/m1/7-chat`:**
  - `packages/runtime/src/execution/ThreadSupervisor.ts:38-39, 51, 58, 60-61, 268, 272, 341, 352, 364, 401`
  - `packages/runtime/src/execution/thread-state.ts:62, 67-69, 284, 335, 346, 382`
  - Propagated to `packages/runtime/src/execution/trigger.ts:74`, `packages/runtime/src/cli/run.ts:197, 209, 229, 234, 239, 245, 293`, `packages/runtime/src/cli/send.ts:11`, `packages/runtime/scripts/queue-probe.ts` (8 sites)
- **Why it costs maintainers:** Erasing the error channel to `unknown` at the supervisor boundary destroys exhaustive `Effect.catchTag` handling for every caller (`cli/run.ts:233-238` and `cli/chat.ts:404-409` both resort to `Cause.squash` + `instanceof ThreadTerminated` / `instanceof RunFailed`).
- **Proposed restructuring:** Define explicit tagged-error unions on `ThreadSupervisor` and `ThreadControl`:
  - `status`: `ThreadNotFound | SqlError`
  - `terminate`: `ThreadNotFound | WriteRefused | SqlError`
  - `queueMessage`: `QueueRefused | ThreadNotFound | WriteRefused | ValueNotJson | SqlError`
  - `queueTool`: `ThreadNotFound | WriteRefused | ValueNotJson | SqlError`
  - `send`: `InvalidOption | SetupError | ThreadNotFound | WriteRefused | ValueNotJson | SqlError`
  - `Live.done` / `settled` / `abortExecution`: `Deferred.Deferred<RunOutcome, SqlError | ThreadNotFound>` (or `StoreError`)
  Then replace `instanceof` checks in `cli/run.ts:233-238` with `Effect.catchTag("ThreadTerminated", ...)`.
- **Line estimate:** +10 / -10 lines (pure type precision + cleaner CLI error matching).
- **Risk and guarding tests:** Low risk (compile-time tightening). Guarded by `pnpm typecheck` and all CLI/conformance tests.
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Ripples positively into **PR 10 (`m1/7-chat`)**, letting `chat.ts` drop `instanceof ThreadTerminated`.
- **Effect APIs verified:** `Effect.catchTag` (`node_modules/effect/dist/Effect.d.ts`), verified via `effect-tsgo` with `anyUnknownInErrorContext: "warning"`.

---

### E2. Raw `new Promise(...)` + `Promise.race` + `AbortController` (`releaseWait`) instead of Effect `Latch` and `Effect.raceFirst`

- **Locations at `origin/m1/7-chat`:**
  - `packages/runtime/src/execution/step.ts:751-761` (flagged by `effect(newPromise)` at `step.ts:756`)
  - `packages/runtime/src/execution/thread-state.ts:32` (`releaseWait: AbortController`)
  - `packages/runtime/src/execution/ThreadSupervisor.ts:145, 201, 251, 296, 304, 319`
- **Why it costs maintainers:** `releaseWait` is never handed to any Web/Fetch API; it is used solely as a one-shot fiber wake signal, requiring manual `addEventListener("abort", ...)` inside a `new Promise` wrapped in `Effect.promise(async () => Promise.race(...))`.
- **Proposed restructuring:** Replace `releaseWait` with `const releaseHold = Latch.makeUnsafe(false)`. Open it once inside `Execution.cancel("drop")` via `releaseHold.openUnsafe()`, and wait in the single finalizer via:
  ```ts
  yield* Effect.raceFirst(
    Effect.promise(() => Promise.allSettled(pending.keys())),
    releaseHold.await,
  )
  ```
- **Line estimate:** Removes ~8 lines (as part of S1).
- **Risk and guarding tests:** Low risk; guarded by `ownership.ts` (O06, O07, O21, O22) and `test/cli/queue.test.ts` (2nd Ctrl-C).
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. No ripple to PR 10.
- **Effect APIs verified:** `Latch.makeUnsafe`, `Latch.openUnsafe`, `Latch.await` (`node_modules/effect/dist/Latch.d.ts`), `Effect.raceFirst` (`Effect.d.ts`).

---

### E3. Finalizer registration order hazard in `ThreadSupervisor.layer` and manual `ensuring` in `answerInterrupts`

- **Locations at `origin/m1/7-chat`:**
  - `packages/runtime/src/execution/ThreadSupervisor.ts:121, 302-311`
  - `packages/runtime/src/cli/run.ts:260-280`
- **Why it costs maintainers:** In `ThreadSupervisor.layer`, `scope` is forked at line 121, `Effect.addFinalizer` (which drops the holder) is registered at line 302 *before* `store.registerHolder(holder)` at line 310, and `tick` is forked into `scope` at line 311. Because Effect runs finalizers LIFO, on teardown `dropHolder` runs *before* `scope` interrupts `tick` — and if `registerHolder` fails, the finalizer still attempts `dropHolder`. Meanwhile, `answerInterrupts` in `cli/run.ts:260-280` manually tracks `remove` with `Effect.ensuring` instead of `Effect.acquireRelease` (unlike `cli/chat.ts:157-160`, which already uses `Effect.acquireRelease`).
- **Proposed restructuring:** Acquire resources in strict lifecycle order inside `ThreadSupervisor.layer` (note: in Effect v4, `Layer.effect` natively handles `Scope`; `Layer.scoped` does not exist):
  1. `yield* Effect.acquireRelease(store.registerHolder(holder), () => Effect.ignore(store.dropHolder(holder.id)))`
  2. Fork execution scope + register execution-teardown finalizer (`closing = true`, `cancel("drop")` all live executions, `Fiber.interruptAll`).
  3. `yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(CONTROL_POLL), Effect.ignoreCause(tick))))` — acquired last so it is interrupted *first* on teardown, before live executions settle and before `dropHolder` runs!
  And in `cli/run.ts:260-280`, use `Effect.acquireRelease(Effect.sync(() => onInterrupt(...)), (remove) => Effect.sync(remove))` with `Effect.scoped`.
- **Line estimate:** Net ~0 lines; eliminates two subtle teardown races.
- **Risk and guarding tests:** Very low risk. Guarded by `ownership.ts`, `queue.ts`, `test/cli/queue.test.ts`, and `test/store/claims.test.ts`.
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Zero ripple to PR 10.
- **Effect APIs verified:** `Layer.effect` (`node_modules/effect/dist/Layer.d.ts`, verified no `Layer.scoped` in v4.1.5), `Effect.acquireRelease`, `Effect.forkScoped` (`Effect.d.ts`).

---

### E4. Duplicated hand-written queue payload validation and throwing `toQueued` causing `try/catch` inside `Effect.gen`

- **Locations at `origin/m1/7-chat`:**
  - `packages/runtime/src/store/schema.ts:217-244` (`isAttachmentRef`, `isQueueMessage`, `toQueued` throwing `new Error("Invalid queued payload")`)
  - `packages/runtime/src/store/sqlite.ts:551-558` (flagged by `effect(tryCatchInEffectGen)` at `sqlite.ts:551`)
  - `packages/runtime/src/execution/ThreadSupervisor.ts:81-114` (`queuedMessage` re-validating the same `QueueMessageInput` shape by hand)
  - `packages/runtime/src/execution/tools.ts:81-82` (a third partial `isAttachmentRef`)
- **Why it costs maintainers:** Queue payload rules live in two hand-written validators that must stay in sync (`Q42` was specifically added after `schema.ts` missed optional fields that `ThreadSupervisor.ts` checked). Because `toQueued` throws on bad JSON/shape, `sqlite.ts:551` uses `try/catch` inside `Effect.gen`.
- **Proposed restructuring:** Define `AttachmentRefSchema`, `QueueMessageSchema`, and `QueueToolPayloadSchema` in `store/schema.ts` using `Schema.Struct`, `Schema.Literals`, `Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))` (or `Schema.Finite` + non-negative integer filter), and `Schema.fromJsonString`. Decode in `toQueued` with `Schema.decodeUnknownOption` so `sqlite.ts:545-560` checks `Option.isSome(decoded)` with zero `try/catch` and zero thrown `Error`s. Keep `queuedMessage`'s custom refusal messages only for the user-facing admission check (reusing `Schema.is(AttachmentRefSchema)` instead of a second predicate).
- **Line estimate:** Removes ~25 lines across `schema.ts`, `sqlite.ts`, and `tools.ts`.
- **Risk and guarding tests:** Low risk; guarded by `queue.ts` (Q06, Q29, Q33, Q42) and `claims.test.ts`.
- **PR and ripple:** **PR 8 (`m1/6-queue`)**. Zero ripple to PR 10.
- **Effect APIs verified:** `Schema.decodeUnknownOption` (`node_modules/effect/dist/Schema.d.ts:1345`), `Schema.fromJsonString` (`cli/main.ts:12` already uses it).

---

### E5. `unyielding`'s type-erasing proxy in `sqlite.ts` and nested `Effect.provide` in `cli/run.ts`

- **Locations at `origin/m1/7-chat`:**
  - `packages/runtime/src/store/sqlite.ts:70-83` (flagged by `anyUnknownInErrorContext` at `sqlite.ts:79`: `unknown` in both `E` and `R`)
  - `packages/runtime/src/cli/run.ts:175, 229, 230` (flagged by `strictEffectProvide`)
- **Why it costs maintainers:** `unyielding` erases every service method signature to `(...args: ReadonlyArray<unknown>) => Effect<any, unknown, unknown>` and casts back `as S`, hiding type errors inside the wrapper. In `cli/run.ts`, providing layers in three separate nested `Effect.provide` calls causes `spindle send` to build `SqliteLive` twice (opening the file and running migrations twice).
- **Proposed restructuring:**
  1. In `sqlite.ts`, either wrap a typed helper `const noYield = <A, E, R>(eff: Effect.Effect<A, E, R>) => ...` around the store methods or type `unyielding`'s mapped object cleanly without `Object.fromEntries` + `as S` (only 22 methods, or a small typed `withUnyielding` helper on `sql` transactions/queries).
  2. In `cli/run.ts`, compose `Registry.layer(root)` and `Layer.provideMerge(supervisor, database)` at one scope per command so `database` is built once for `spindle send`.
- **Line estimate:** Net ~0 lines.
- **Risk and guarding tests:** Low risk. Guarded by `claims.test.ts:400` and `test/cli/queue.test.ts`.
- **PR and ripple:** **PR 8 (`m1/6-queue`)** for `cli/run.ts` and `sqlite.ts:70-83` (`unyielding` was introduced in PR 8). Zero ripple to PR 10.
- **Effect APIs verified:** `Effect.service`, `Effect.provideService`, `Scheduler.PreventSchedulerYield` (`Effect.d.ts`, `Scheduler.d.ts`).

---

### E6. Confirmed `@effect/language-service` (`effect-tsgo`) diagnostics in PR 8's files at `origin/m1/7-chat`

Running `effect-tsgo@0.73.7` in the scratch checkout at `43a4d5b` (with `unstableApiUsage: "off"` and extended rules enabled) confirmed the following actionable diagnostics on files PR 8 owns or touched (excluding `anyUnknownInErrorContext`, `newPromise`, and `strictEffectProvide` already covered in E1, E2, E5):

- **`effect(effectSucceedWithUndefined)` (default rule):**
  - `packages/runtime/src/execution/ThreadSupervisor.ts:401` (**PR 8**) — `Effect.succeed(undefined)` -> `Effect.undefined`.
  - (`hooks.ts:472` is from PR 7.)
- **`effect(tryCatchInEffectGen)` (default rule):**
  - `packages/runtime/src/store/sqlite.ts:551` (**PR 8**) — covered in E4.
  - (`tools.ts:130` is PR 6; `hooks.ts:501` is PR 7.)
- **`effect(globalErrorInEffectFailure)` (default rule):**
  - `packages/runtime/src/execution/thread-state.ts:226, 303` (originated in PR 6, still in PR 8's rewritten `thread-state.ts`) — `Effect.fail(new Error(...))` for missing definitions and missing env vars; should be `Data.TaggedError`s so they don't merge as untyped `Error`.
- **`effect(unknownInEffectCatch)` (default rule):**
  - `packages/runtime/src/execution/tools.ts:104, 120` (originated in PR 6; line 120 edited by PR 8 for `invokeCallback`) and `call.ts:372` (PR 6) — `Effect.tryPromise({ try, catch: (cause) => cause })` returns `unknown`; wrap in a small `Data.TaggedError` (e.g. `UserCallbackError`).
- **`effect(missingConcurrencyOption)` (extended rule):**
  - `packages/runtime/src/execution/step.ts:309` (PR 6/8) — `Effect.forEach(pending, Fiber.join, { discard: true })` can be `Fiber.joinAll(pending)` (or explicit `{ concurrency: "unbounded", discard: true }`); `step.ts:449` (PR 7) runs hooks sequentially and should state `{ concurrency: 1, discard: true }`.
- **`effect(flatMapMapToZipWith)` (default rule):**
  - `packages/runtime/src/store/sqlite.ts:365` (PR 4, present at tip) — `Effect.flatMap(Effect.serviceOption(...), (outer) => Effect.map(read, ...))` -> `Effect.zipWith`.
- **`effect(effectTryWithoutCatch)` (extended rule):**
  - `packages/runtime/scripts/queue-probe.ts:128` (**PR 8**) — `Effect.tryPromise(() => act(state))` without `catch`.
- **Default test-file diagnostics introduced by PR 8:**
  - `effect(catchToOrElseSucceed)` and `effect(flatMapToTap)`: `packages/runtime/test/cli/processes.ts:67-68` and its copy in `packages/runtime/test/cli/queue.test.ts:53-54` (`Effect.catch(() => Effect.succeed(-1))` -> `Effect.orElseSucceed(() => -1)`, and `Effect.flatMap((code) => Effect.as(Fiber.join(reading), code))` -> `Effect.tap(() => Fiber.join(reading))`).
  - `effect(unnecessaryEffectGen)`: `packages/runtime/test/cli/processes.ts:114`, `packages/runtime/test/cli/queue.test.ts:73, 77`, `packages/runtime/test/store/claims.test.ts:20` (single-line `Effect.gen` returning `yield* Service` — in Effect v4 a `Context.Service` tag is already yieldable directly, e.g. `Effect.flatMap(FileSystem.FileSystem, ...)` or `ThreadStore.use(...)` as `cli/status.ts:58` already does!).
- **Line estimate:** ~20 lines changed across PR 8's source and test files (mostly mechanical cleanup once E1–E4 are done).
- **Risk and guarding tests:** Trivial risk; guarded by `pnpm typecheck && pnpm test`.
- **PR and ripple:** **PR 8 (`m1/6-queue`)** for PR 8's own lines (and PR 4/6/7 for the pre-existing lines noted above).
- **Effect APIs verified:** `Effect.undefined` (`Effect.d.ts`), `Fiber.joinAll` (`Fiber.d.ts`), `Effect.orElseSucceed`, `Effect.tap`, `Effect.zipWith` (`Effect.d.ts`).

---

## 4. Duplication Seen With Code From Other Pull Requests

- **CLI script loading (`cli/run.ts:35-45` vs `cli/chat.ts:75-86`):** `loadScript` (PR 6) and `readScript` (PR 10) are identical 11-line functions.
- **CLI validation + error printing (`cli/run.ts:180-192` vs `cli/chat.ts:350-357`) and CLI `catchCause` boundary (`cli/run.ts:232-241` vs `cli/status.ts:35-41` vs `cli/chat.ts:403-410`):** Copy-pasted across PR 6, PR 8, and PR 10 (and omitted from `recoverCommand` in `cli/status.ts`).
- **Redacting console & custom stderr `Logger` (`cli/run.ts:49-55, 148-156` vs `cli/chat.ts:328-337`):** Built twice with slight drift (`chat.ts` also escapes terminal control characters).
- **Multi-process test harness (`test/cli/queue.test.ts:13-114` vs `test/cli/processes.ts:9-144` vs `test/cli/chat-process.ts`):** `processes.ts` copied `queue.test.ts`'s entire spawn/poll helper block inside PR 8, and PR 10's `chat-process.ts` repeated the same `collect`/`exitCode` pattern (`chat-process.ts:68-69` even carries the exact same two `effect-tsgo` diagnostics as `processes.ts:67-68` and `queue.test.ts:53-54`!).
- **Micro-predicates repeated across PR 4–PR 8:** `isRecord` is redefined 8 times across `ThreadSupervisor.ts:65`, `thread-state.ts:86`, `tools.ts:27`, `hooks.ts:59`, `messages.ts:47`, `call.ts:27`, `assemble.ts:19`, and `schema.ts:182`; `isCount` is redefined 4 times (`ThreadSupervisor.ts:68`, `hooks.ts:107`, `schema.ts:215`, `sqlite.ts:98`); `noInvoke` is duplicated between `step.ts:362-366` and `trigger.ts:38-42`; `nowMicros` is duplicated between `sqlite.ts:85` and `messages.ts:45`.

---

## 5. What Is Good and Should Not Be Touched

- **`packages/runtime/src/execution/run-status.ts` (74 lines):** Crisp, pure, data-driven state transition table (`TRANSITIONS`, `IDLE_REASONS`, `FAILED_REASONS`, `transition`, `CLOSING`) with direct unit tests (`run-status.test.ts`). This is the cleanest module in PR 8 and a model for how `Execution` (S1) should look.
- **Transactional SQLite guarantees in `sqlite.ts`:** Atomic `admit` (insert queue row + claim idle/failed thread in one `BEGIN IMMEDIATE`), atomic `insertMessage` with `dequeue` (`DELETE FROM queue ... RETURNING seq`), atomic `settle` (close open calls + check pending queue + release claim + update status), and atomic `terminate` (mark `terminated_at` + settle running flow + close open calls). Keep every one of these transaction boundaries intact.
- **Runtime-owned `flow_id` and `caller_seq` columns + binary-safe `CAST(tool_call_id AS BLOB)` matching (`0003_claims.ts`, `sqlite.ts:153-191`, `schema.ts:26-28`):** Cleanly solves NUL truncation on `node:sqlite`, call-ID reuse across turns (O16), and hook-tampered `prompt` fields (O14).
- **Signal-zero PID probing (`platform/process-alive.ts`) + two-phase `recover` (`sqlite.ts:596-619`):** Probing PIDs outside the write lock and re-verifying inside `sql.withTransaction` avoids holding `BEGIN IMMEDIATE` across syscalls while keeping recovery atomic, and keeping `node:`/`process.kill` behind `#platform` honors the platform boundary.
- **`unyielding` on `ThreadStore` (`sqlite.ts:70-83`) and `{ uninterruptible: true }` on `forkIn` (`ThreadSupervisor.ts:193`):** Both solve real, non-obvious invariants (synchronous `queueTool` never colliding with an in-flight fiber on the single SQLite connection, tested by `claims.test.ts:400`; and same-turn abort installing settlement finalizers before interruption, tested by O21). Only remove the *extra* fiber-wide `PreventSchedulerYield` in `ThreadSupervisor.ts:153`, not `sqlite.ts`'s `unyielding`.
- **`test/store/unfenced.test.ts`:** A 19-line regression guard ensuring raw unfenced store mutations never creep back onto `ThreadStore`.

---

## 6. What I Could Not Judge and Why

- **Performance trade-offs of removing fiber-wide `PreventSchedulerYield` (`ThreadSupervisor.ts:153`) under `queue-probe.ts bench`:** The brief treats performance as a non-goal (except thread-length scaling) and I did not run multi-process benchmarks in the scratch checkout, so I cannot quote the exact millisecond delta of moving `PreventSchedulerYield` strictly back to `sqlite.ts`'s `unyielding` wrapper. (No thread-length O(n^2) scaling issue was introduced by PR 8; `history.ts` caches by `revision` and `0003_claims.ts` indexes `messages(flow_id)` and `messages(caller_seq)`.)
- **Downstream M2/M3/M4 requirements on `ThreadControl` and `WritingHandle`:** `docs/design/thread-ownership.md` sketches nested prompts and scheduled alarms for later milestones; while explicit `WriteOrigin` (S6 step 2) looks cleaner than ambient `WritingHandle` for M1, verifying how nested prompts share a flow across M2 was outside M1's code.
- **Whether `spindle recover` intentionally accepts a relative `--db` without `path.resolve` in error messages:** `test/cli/ownership.test.ts:61` asserts `spindle: no thread absent in ${db}` with the exact `db` string passed on the CLI (which happens to be absolute in that test). Any `path.resolve` change in `recoverCommand` should still format the error with the user's `--db` or match `statusCommand` consistently.
