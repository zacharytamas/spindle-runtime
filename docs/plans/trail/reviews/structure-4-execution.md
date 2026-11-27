2 BLOCKS, 2 SHOULD FIX.

# Review of PR 14, `m1/11-execution`, "give the life of an execution one model"

Head `38b45f0244ab0dbb6c780a61e89411e1594a6b22`, base `57eec19`. All `path:line` citations are at the head unless they say "base". I worked in scratch copies at `/tmp/structure/review-4b/head` and `/tmp/structure/review-4b/base`. I did not use anything from `/tmp/structure/review-4/`.

The gate passes. At the head, 526 tests pass on Node and on Bun. At the base, 520 pass on each (`gate-*.log`). I wrote four witnesses and ran each at both revisions on both runtimes. The double settlement was real at base, and the fix is right. The windows before the first turn, for a new run and for a successor, behave the same at base and head. Typed rejections from `ThreadState` are unchanged. The restructuring has a real ordering problem where the yield guard was removed, and it has two uncounted changes to the stop and abort contract.

## BLOCKS 1. An abort that lands just after an ordinary settlement makes the sender report `failed / execution_lost` for a run that settled normally

**What happens.** The execution fiber now yields wherever its budget of 2048 operations runs out. The only exceptions are inside the guarded store calls and inside the commit guard at `packages/runtime/src/execution/Execution.ts:160-167`. The budget keeps counting under a guard. If it runs out inside the commit guard, the fiber yields at the first operation after the guard (`node_modules/effect/dist/internal/effect.js:476-491`, `dist/Scheduler.js:133-135`). That point comes before the driver enters the interruptible metadata join at `Execution.ts:172` and `:189`.

1. An abort runs in that turn and calls `cancel` (`Execution.ts:104-112`).
2. The phase is already `ended`, so the only thing that acts is `this.#fiber?.interruptUnsafe()` at `:110`.
3. The fiber is masked, so the interrupt is held until the join turns interruptible, and then it fires.
4. The handler at `:190-205` reads the thread and finds it not terminated.
5. The sender gets `failed / execution_lost` with an empty trace and no model calls. The store holds the real settlement.

At the base this could not happen without pending metadata. `PreventSchedulerYield` covered the whole execution fiber (base `ThreadSupervisor.ts:162-163`). An abort in the next turn either found nothing or found the fiber in its `onExit` with the outcome already fixed.

A second, smaller window of the same kind sits between the exit of `Effect.interruptible(advance)` at `:130` and the commit guard. An abort there sets the phase to `holding`. The commit then stores the step's own reason, and the join later reports `execution_lost`. I reasoned this one out and did not witness it.

**Witness, run on both runtimes at both revisions.**

- File: `/tmp/structure/review-4b/witness-src/w1-abort-after-commit.test.ts`. Run it with `REV=head pnpm exec vitest run packages/runtime/test/review4b/w1-abort-after-commit.test.ts` from the head copy, and with `bun --bun run vitest run …` for Bun.
- Each round makes one model call wait on a gate, queues k messages of the prompt side, and releases the call. The run then continues, drains the k messages, and settles `idle / awaiting_human`.
- From inside that final commit, the test dispatches `supervisor.abort` with `setImmediate`. k sets how much work runs between the model call's return and the commit.
- Results are in `witness/w1-{base,head}-{node,bun}.json`, summarised in `w1-summary.txt`.

```
head node  k=16 ops=2039 interrupted a live execution  sender=failed/execution_lost trace=0  stored=idle/awaiting_human
head bun   k=19 ops=2184 interrupted a live execution  sender=failed/execution_lost trace=0  stored=idle/awaiting_human
base node  0 of 24 rounds differ, no abort found a live execution
base bun   0 of 24 rounds differ, no abort found a live execution
```

**Who can reach it.**

- Callers of `supervisor.abort`: the second Ctrl-C of `spindle run` (`cli/run.ts:263`), the conformance driver, and any embedder.
- The chat command calls `stop` first, and `stop` returns false once the run has ended, so chat can reach only the window before the commit.
- Each abort has a small chance: one macrotask, in runs whose budget runs out inside the commit guard. For a given workload it is deterministic, and the test reproduces it on both runtimes.
- What changes is the outcome the sender receives and prints. The stored data and the claim are correct.

**Smallest fix that keeps base behavior. I tested it** (`/tmp/structure/review-4b/fix-a.diff`). Run the whole driver with the guard, and lift the guard only for the step work:

```ts
const exit = yield* Effect.exit(
  Effect.interruptible(advance).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, false)),
)
...
Effect.forkIn(Effect.provideService(publish, Scheduler.PreventSchedulerYield, true), scope, { uninterruptible: true })
```

With this change, W1 shows no differing round on either runtime. The full suite passes 526 of 526 on Node and on Bun (`logs/fixA-suite-*.log`). That includes the implementer's starvation test, because the step work still yields. The guard on `settle` at `:166` becomes redundant. I reverted the change in the scratch copy.

**Better fix, which changes behavior and so is the operator's call.** Keep the interrupt of an ended execution's join, but answer it with the result that committed. Replace the store read at `:190-205` with `brief(result)`, and keep `this.#abort.abort()` so the metadata request stops. This closes the window by construction. It also removes the base's own misreport during a pending metadata join, and it removes the only `ThreadStore` dependency in `Execution`. The test `settlement.test.ts:134-140` would then expect `idle / stop_on_response` for "abort".

## BLOCKS 2. The pull request's Scope does not count two changes to the supervisor's stop and abort contract

The Scope says one behavior changes. W2 (`witness-src/w2-windows.test.ts`, `witness/w2-*.json`, run on both runtimes at both revisions) shows two more.

**(a) `stop` now returns false while an abort holds the thread, and while the execution is dropping.** At base, `stop` returned true until the run had ended (base `ThreadSupervisor.ts:401-407`). The head's check is at `Execution.ts:84`, called from `ThreadSupervisor.ts:319`. Neither version changes the run.

- W2, "a holding abort then a stop while a tool runs": base returns `true`, head returns `false`. Everything afterwards is identical.
- Chat reads this boolean in its interrupt and close handlers (`cli/chat.ts:254`, `:257`).
- Chat sees a difference in only one short interval: after a line is forked as a send and before the send's `onWaiting` callback sets `waiting`.
  - In that interval, a Ctrl-C now ends the chat, where base printed the stopping note.
  - An end of input now closes at once, where base waited for the queued line.
- I reasoned out the chat effect; I did not witness it.
- The PR body names this change under "What changed" but leaves it out of Scope.

**(b) An exiting abort followed by a holding abort no longer resumes queued work.** At base, the second abort set `waitForCallbacks` back to true (base `ThreadSupervisor.ts:331`), so the settlement claimed a successor (base `step.ts:781`). At the head, `cancel("hold")` leaves a dropping execution dropping (`Execution.ts:107`), so `restart` is false (`:169`).

- W2, "an exiting abort then a holding abort while a tool runs, with a message queued":
  - Base answered the queued `B`: stored `idle / stop_on_response`, two provider requests, queue empty.
  - Head left `B` queued: stored `idle / aborted_by_user`, one provider request, one entry queued.
  - The same on Node and Bun.
- No caller in the repository makes this sequence. `spindle run` removes its handler after the exiting abort (`cli/run.ts:266`), and chat and the driver only use holding aborts.
- The PR does not disclose this change.

**Smallest fix.** Name both in the Scope, and add W2's case (b) as a test so the new rule is pinned. I would keep both new behaviors. Case (b) matches the design note's rule that an orderly exit settles its aborting flows and starts nothing. Case (a) makes `stop` mean "a stop took effect". If the operator wants base behavior for (a), it is one line: `requestStop` returns `!this.ended` and changes the phase only from `running`. I would not restore (b), because that brings back a restart after an exit.

## Events against phases

Evidence codes:

- **W**: a witness I ran at both revisions on both runtimes.
- **T**: a named test that passes at both base and head.
- **R**: reasoned from the code at both revisions.

In every row, the stored run status during the event is the same at base and head. It reads `running` until the settling transaction. A terminate and a recovery commit their own settlement at once.

The claim is released at the same moment at base and head in every row except BLOCKS 2(b), where the head does not claim a successor.

| Event | Phase | Base | Head | Same | Evidence |
|---|---|---|---|---|---|
| Stop | Before first turn | true. Settles `idle / aborted_by_user` at the first boundary. Queued work waits. | Same | Yes | R |
| Stop | Running | true. The current operation finishes and the run settles `idle / aborted_by_user`. | Same | Yes | T Q11 |
| Second stop | Stopping | true. The first requester is kept. | Same | Yes | R `Execution.ts:86` |
| Stop | Holding | true, no effect | false, no effect | No | W2, BLOCKS 2(a) |
| Stop | Dropping | true, no effect | false, no effect | No, return value only | R, BLOCKS 2(a) |
| Stop | Ended, before publication | false | false | Yes | R |
| Abort | Before first turn | Masked start. Settles `idle / aborted_by_user`. A successor claims the queued message and runs it. | Same | Yes | W2, T O21 |
| Abort | Running or stopping | Signal fires. The run yields and waits for live callbacks. Settles `idle` with the first stop's reason. Queued work resumes. | Same | Yes | T O06, W2 |
| Second abort | Holding | No change | No change | Yes | R |
| Holding abort | Dropping after an exiting abort | Restart re-enabled, queued work runs | Stays dropping, no restart | No | W2, BLOCKS 2(b) |
| Abort | After step work, before commit | Unreachable, because the fiber did not yield there | Commits the step's reason, then reports `failed / execution_lost` | No | R, BLOCKS 1 |
| Abort | Ended, metadata pending | Join interrupted. Sender gets `failed / execution_lost`, empty trace. | Same | Yes | T `settlement.test.ts:76-146`, R base `step.ts:776-781` and `ThreadSupervisor.ts:169-185` |
| Abort | Ended, no metadata pending | Sender gets the real outcome | Sender gets `failed / execution_lost` if the fiber yielded after the commit guard | No | W1, BLOCKS 1 |
| Exiting abort | Before first turn | Settles `idle / aborted_by_user`, no successor | Same | Yes | W2 |
| Exiting abort | Holding | Wait released. Settles `idle / aborted_by_user`, no successor. | Same | Yes | R, T second Ctrl-C test |
| Terminate, this process | Before first turn | The terminate transaction settles `idle / aborted`. Sender gets `idle / aborted`. | Same | Yes | W2 |
| Terminate, this process | Running or holding | Settles at once and releases the wait. Later writes refused. | Same | Yes | T O07, Q13 |
| Terminate | Ended, metadata pending | Sender gets the stored status with an empty trace | Same | Yes | T `settlement.test.ts` |
| Terminate, another process | Running or holding | Poll interrupts within 250 ms. Sender gets `idle / aborted`. | Same | Yes | T "a terminate from another process aborts the running tool" |
| Forced recovery | Running or holding | Poll interrupts. Sender gets `failed / execution_lost`. Writes refused. | Same | Yes | T "a frozen process whose thread was recovered by force" |
| Recovery or remote terminate | Ended | Poll skips an ended run | Same | Yes | R `ThreadSupervisor.ts:248` |
| Scope close | Running | Interrupt. Settles `idle / aborted`, no successor. | Same | Yes | R |
| Scope close | Holding | Wait released. Settles `idle / aborted_by_user`, no successor. | Same | Yes | R |
| Scope close | Ended, metadata pending | Join interrupted, `failed / execution_lost` | Same | Yes | R |
| Callback settles | Holding | The last one releases the claim, and queued work resumes | Same | Yes | T O06, W2 |
| Hook timed out earlier | Holding | Not waited for | Same | Yes | T O22 |
| Callback never settles | Holding | Held until a terminate, a recovery, an exiting abort, or scope close | Same | Yes | R |
| Database refuses the idle settlement | Ordinary end | A second settlement as `failed / step_error`. The sender gets a successful delivery describing it. | The sender gets `SqlError`. The row stays `running` until the poll settles it `failed / execution_lost`. | No, the stated fix | W4 |
| Database refuses the settlement | Abort path | The sender gets a defect wrapping `SqlError` | The sender gets a typed `SqlError`. The row ends the same way. | Error channel only | W4, note 3 |
| Database refuses every release | Any | `SqlError`. The row stays `running` because the poll is refused too. | Same | Yes | W4 |
| Database error at a step write | Running | Settles `failed / step_error` | Same | Yes | R `Execution.ts:21-45` against base `step.ts:731-759` |
| `FlowEnded` from a step write | Running | No settlement. The run reads the thread to choose its reason. | Uses `FlowEnded.why` from the refused write | Yes, except when the thread is terminated between the refusal and base's read | R, note 4 |
| Interrupt at an await | Running | The abort or terminate path | Same | Yes | R |
| Late write from user code | Holding, dropping, ended | `HandleExpired` while aborted, `ExecutionEnded` after the commit, `FlowEnded` at the commit | Same | Yes | R `thread-state.ts:160-169`, T O07 |

## SHOULD FIX, with the answers to points 2, 3 and 4

### SHOULD FIX 1. The `stopping` phase is state that nothing reads

`#phase = "stopping"` is written at `Execution.ts:85`, and the only code that reads it is `requestStop`'s own check at `:84`. Every other branch treats `stopping` like `running`. `#stop` at `:59` already records that a stop was asked for and by whom. The plan's table therefore has two rows that describe `#stop`, not a phase: Running to Stopping, and Stopping to Stopping.

The fix is to delete the phase. The check becomes `this.#phase !== "running"` and the assignment goes. That leaves four phases and one fewer row, with no change in behavior.

### SHOULD FIX 2. `providerFor` hides the nested effect from the checker instead of removing it

At `providers/config.ts:97-129`, the generator returns `{ perRequest, build }`. A second pipeline stage then turns that back into `Effect<Effect<Provider>>` with `Effect.map(build, Effect.succeed)` (`:129`).

- The caller at `step.ts:382-385` gets the same nested shape that base produced.
- Base did this in three readable lines.
- The `returnEffectInGen` rule stopped firing only because the nesting moved out of the generator.

A plain record keeps the same two lifetimes without the boolean or the second stage: `return { request: perRequest ? build : Effect.succeed(yield* build) }`, then read `.request` at `step.ts:384`.

### Point 2. Is every state reachable, and is every transition in one place?

All five phases are entered:

- `running` at construction.
- `stopping` by `requestStop`.
- `holding` by `cancel("hold")`.
- `dropping` by `cancel("exit" | "displace")`.
- `ended` in the commit's `onExit` at `:161-165`.

Each transition has one place, with three exceptions:

- The interrupt of the fiber is written twice, at `:110` and `:217`. The second is needed because the execution enters `live` before its fiber exists. I would not reorder that, because forking before registering opens a stale-entry race.
- The signal fires at three sites: `:133`, `:144` and `:192`.
- `stopping` duplicates `#stop` (SHOULD FIX 1).

Fields where the order of updates matters:

- `#stop`: the first writer wins, in both `requestStop` and `cancel`.
- `holding`, which is sampled at `:158` before the commit. A displacement after the sample cannot cause a wrong restart, because `restart` also needs `settled`. A terminate, a recovery, or a local displacement makes the store return `terminated` or `superseded`, and scope close sets `closing`.

Private state that callers branch on through a getter:

- `ended`: `ThreadSupervisor.ts:157` and `:248`, `thread-state.ts:165`.
- `stopped()`: seven sites in `step.ts`.
- `waitingOn`: `ThreadSupervisor.ts:282`.
- `signal.aborted`: `thread-state.ts:167`.

`signal.aborted` is a second source of "aborted" beside the phase. An execution can be `holding` before its signal fires, when the cancel arrives while it is masked, and it can end without the signal ever firing, after an ordinary settlement. The spec's `abortSignal` makes this unavoidable. Even so, `ThreadState` decides whether a handle is dead from four facts (`thread-state.ts:160-169`).

The code does not match its tables in two places:

- The plan's table in `docs/plans/m1-core-loop.md`, section "Settled in M1-11", allows `continue` only from running or stopping. The driver also continues from `holding` when an abort lands before the commit.
- The PR report's row "Ended with metadata pending | Interrupt" understates the code, which interrupts every ended execution (BLOCKS 1).

### Point 3. Is it the simpler shape?

I agree with two claims. The source is three lines smaller. No writable lifecycle field is shared across files, apart from one: `stopped` at `Execution.ts:76` is a public, non-`readonly` property.

**Is `Execution.ts` one model or the old bag moved into a class?** The state part is one model:

- Four flags (`waitForCallbacks`, `displaced`, `resumeQueued`, `ended`) and the `releaseWait` controller became one phase and one latch.
- Each transition is a method.
- There is one finalizer instead of two coupled ones.
- "Lost or terminated" is now decided by the store's own transaction instead of four separate reads.

That is a real improvement over base.

The class still does two jobs:

- A state model of about 65 lines (`:47-112`).
- A driver of about 100 lines (`:114-219`). It runs the step loop, commits, classifies failures, reads the store late, builds the outcome, claims a successor, and publishes.

The model has no tests of its own. All eighteen of the implementer's mutation catches came through scenario and CLI tests.

**What could still go:**

- The late read and the masked-versus-interruptible split of the join, about 20 lines. The better fix in BLOCKS 1 removes them.
- The `stopping` phase (SHOULD FIX 1).
- `failure` and `settledAs` could move next to `End`, so the driver reads as a sequence.

Splitting the model from the driver, and testing the model with a table the way `run-status.test.ts` tests `run-status.ts`, is the structural move the operator's standard asks for. It is not small, so I list it here rather than as a SHOULD FIX.

**What in `step.ts` (687 lines) still belongs to the lifecycle:**

1. The stop check at seven boundaries (`step.ts:427`, `:524`, `:555`, `:557`, `:612`, `:652`, `:656`), with `stopHere` at `:545-548`.
2. `report` at `:283-303`. Only `Execution` calls it, and `Execution` decides whether its join can be interrupted.
3. `Effect.cached(setup)` at `:305`, and the loop state `turnStart` and `turnSteps` (`:549-550`, `:573`, `:673`). These exist only so the driver can re-enter `advance` after `continue`.
4. `run.recordStep()` at `:635`, and `stepCap` returned at `:686` only so `Execution` can compute `atCap`.
5. The callback tracker passed in as `pending: run` at `:318`, `:341` and `:358`, and through `executeTool` at `:511`.

The rest is the step's own work and belongs to the next two pull requests: assembly, hook calls, the drain, queued tools, and message writes.

### Point 4. Is the Effect usage right?

I checked each use against the installed declarations:

- `forkIn` with `uninterruptible: true` starts the fiber masked, and explicit `Effect.interruptible` regions can still be interrupted (`Effect.d.ts:17777` doc, `internal/effect.js:2492-2507`). `interruptUnsafe` on a masked fiber only records the cause (`effect.js:385-402`).
- `Latch.makeUnsafe()` starts closed (`Latch.d.ts:129`).
- `Deferred.makeUnsafe`, `done`, `await` and `isDoneUnsafe` are used as declared.
- `Effect.cached` returns `Effect<Effect<A>>` (`Effect.d.ts:14106`).
- `PreventSchedulerYield` turns off only the automatic yield check. The budget keeps counting under the guard, and an explicit `yieldNow` still yields (`effect.js:476-491`). This is the mechanism behind BLOCKS 1.

Otherwise the masked start, the latch, the deferred, the scopes, and interruption are right.

The effect-tsgo check exits 0 (`tsgo-head.log`):

- Head has 7 suggestions; base had 11.
- In files this PR touched, the only findings are at `hooks.ts:467`, `hooks.ts:502` and `tools.ts:127`, all pre-existing.
- `globalErrorInEffectFailure` and `returnEffectInGen` have no findings at warning. SHOULD FIX 2 covers how the second one was achieved.
- With `anyUnknownInErrorContext` raised to warning on the runtime source, base has 31 findings and head has 10. None are in `execution/`. The rest are in `cli/run.ts`, `cli/send.ts`, `cli/main.ts` and `Registry.ts` (`tsgo-unknown-*.log`).

## Point 5. Did this pull request make S22 slower?

No. I ran S22 ten times at each revision on each runtime, and rotated the order every round (`s22-time.sh`, `s22/times.tsv`). All 40 runs passed.

| Runtime | Base median (ms) | Head median (ms) | Base range (ms) | Head range (ms) |
|---|---:|---:|---:|---:|
| Node | 3,807 | 3,831 | 3,653 to 3,965 | 3,650 to 4,096 |
| Bun | 3,980 | 3,941 | 3,764 to 4,270 | 3,857 to 4,382 |

The medians differ by +24 ms and −39 ms, and the ranges overlap almost completely.

S22 sits near its limit because about 3.0 s of its time is deliberate real backoff, the same at both revisions:

- 1,000 ms in the mid-stream case.
- 1,500 ms in the cut-stream case.
- 500 ms in the native-timeout case.

The six error-code cases cost about 0.5 s in total, because their errors carry `retryAfter: 0` (`witness/s22-profile-*.json`). That leaves about 1 s of headroom under a 5 s limit on either revision, so a loaded machine can push it over. A larger per-test timeout for S22 would remove the flake. That is outside this pull request.

## Point 6. What to change in the `Execution` interface now for the next two pull requests

**The hooks pull request** makes hooks three typed kinds owned by the operations they decorate, and splits the message write in two.

- Today every hook and tool call threads the execution through as a `pending` parameter: `HookScope.pending`, `ToolContext.pending`, the `pending` argument of `executeTool`, and `callHook`.
- Each call builds a `Callback` and passes that tracker to `invoke` and `expire` (`callback.ts:3`, `:17`, `:22`).
- Give `Execution` one method that runs user code, for example `execution.call(operation, fn, timeout?)`. It would own `track`, `forget`, `expire` and the handle's `finished` and `expired` state. The typed hook kinds then take the execution, not a tracker parameter.
- Move the stop check to one boundary method that returns an `End` or nothing. Each new hook boundary can then call it instead of repeating `if (run.stopped()) return yield* stopHere`.
- For the split write, expose one liveness answer for handles: live, aborted, or ended. Then the two halves of the write ask one question instead of the four facts at `thread-state.ts:160-169`.

**The chat pull request** makes the chat command one fiber that drains one queue of events.

- Chat now polls and interprets: `previous?.isDone()`, the `onWaiting` callback with `abortedOperation`, and the boolean from `stop`, which is now false during a hold.
- Have the execution publish its life as events to a queue the chat can drain: stopping, holding with the operation it waits on, dropping, ended with the outcome, and successor started.
- Then `abort` need not return a handle with `isDone`. `stop` can return what happened (stopping, already aborting, or no run) instead of a boolean that chat has to guess about. `SendOptions.onWaiting` becomes one of those events.
- Make the decision on BLOCKS 1's better fix before then, so the event for "ended" always carries the committed result.

## Notes

1. W3: what a tool sees when `env`, `loadModel`, `loadPrompt` or `loadAgent` rejects is identical at base and head on both runtimes: a plain `Error` with the same message, the same own properties (`message`, `stack`), no symbols, and the same string (`witness/w3-*.json`).
2. W4: after a refused settlement, the poll settles the row `failed / execution_lost` within one interval, about 250 ms. "The thread stays running for recovery" is true only until that poll. At base the row ended `failed / step_error`.
3. W4: when the settlement on the abort path is refused, the sender's cause changes from a defect to a typed `SqlError`. Promise callers and the CLI see the same object.
4. With `FlowEnded`, the head uses the reason decided in the refused write. Base read the thread afterwards. The two differ only if the thread is terminated in between, and the head's answer is the atomic one.
5. The PR's account of the late read is right for base when metadata is pending (base `step.ts:776-781`, base `ThreadSupervisor.ts:169-185`). It leaves out that the head now reaches the same read with no metadata pending (BLOCKS 1).
6. W2: a send then an abort, a `queueMessage` then an abort, a send then a terminate, and a send then an exiting abort, all before the first turn, behave identically at base and head on both runtimes. So does an abort of a successor before its first turn. In both versions an abort before the first turn does not stop the queued message: a successor runs it.
7. The snapshot comment at `step.ts:582-584` now overstates. A yield can fall between `history.read` and the first `filter_messages` hook, so a writer in the same process can land between them. I reasoned this out; another process could always do so.
8. `stopped` at `Execution.ts:76` should be `readonly`.
9. `sideAStepCount` and `sideBStepCount` (`thread-state.ts:122-127`) now assume one side per execution. Nothing in the code states that assumption.
10. The signal fires at three sites (`Execution.ts:133`, `:144`, `:192`). One private method that revokes handles would keep "handles die" in one place.
11. `remove()` runs as a bare side effect inside the `onExit` callback (`Execution.ts:210-213`). `Effect.sync(remove)` would make the order explicit.
12. A `forkIn` into an already closed scope never runs `publish`, so `#done` never completes and `remove()` never runs. Base has the same gap. It is reachable only if a claim lands after the supervisor's scope has closed.
13. The head now closes the poll first and drops the holder last, as E3 of the quality review asked.
14. Abort, terminate and the poll now act on an execution that is in `live` before its fiber exists. Base skipped such an execution when `fiber === undefined`. This is a narrow improvement.
15. `HookCall` is built as `Object.assign(new Callback(), {...})` (`hooks.ts:475`), which mixes a class instance with ad hoc fields.
16. `track` closes the latch when a callback starts during a hold (`Execution.ts:91`). As far as I can find nothing reaches it, because every `ThreadState` call is refused once the signal fires. It is harmless.
17. I checked out the detached head in the worktree as the brief asked, and left it there. The worktree is clean. All builds, tests and witnesses ran in the scratch copies.

## Where the evidence is

- Gate: `/tmp/structure/review-4b/gate-{base,head}-{node,bun}.log` and the matching `.json` files.
- Witness sources: `/tmp/structure/review-4b/witness-src/` (W1 to W4, and the S22 profile). Copies are in `{base,head}/packages/runtime/test/review4b/`. Runner: `run-w.sh <file> <rev> <runtime>`.
- Witness output: `/tmp/structure/review-4b/witness/*.json`. Logs: `/tmp/structure/review-4b/logs/`.
- Fix test: `/tmp/structure/review-4b/fix-a.diff`, `witness/w1-head-fixA-*.json`, `logs/fixA-suite-*.log`.
- S22: `/tmp/structure/review-4b/s22/times.tsv`.
- Effect checker: `/tmp/structure/review-4b/tsgo-{base,head}.log` and `tsgo-unknown-{base,head}.log`.
