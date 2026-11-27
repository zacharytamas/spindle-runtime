2 BLOCKS findings.

# Audit C of the M1-6 fix round

Audited `2ca86ee8953ab8cafbd634fed20bc7c20f3eb38a` (PR 8, `m1/6-queue`), the range `d4f5b87..2ca86ee`. I changed nothing in the repository and posted nothing. `git status` is clean and the worktree is detached at the head, as the brief asked.

**The short version.** Nineteen of the twenty items are fixed in the code. Item 19 fixes the door it tested and leaves the invariant it states open through another door, which is the first blocking finding. The second blocking finding is new in this round: the hold after an abort also waits for a hook that the runtime had already timed out. Both leave a thread `running` with nothing in the process that will settle it. I tried a small fix for each in a scratch copy, and with both applied the suite passes 449 of 449 and both witnesses are cured. The ordinary paths, the commit cuts, and competing recovery hold exactly as they did for audit A. One point of failure that held before no longer holds: a repeated `terminate` (point 22, which does not block by the brief's gate).

**Labels I use.**
- *Detected* means: I broke the fix in a scratch copy, ran the whole Node suite, and at least one test failed or hung.
- *Not detected* means: with the fix broken, all 449 tests still passed. The fix can still be correct. It means no test proves it.
- `m…` names a mutation in `/tmp/swarm-m1-6/audit-c/mutate.py`. `W…` names a witness test in `/tmp/swarm-m1-6/audit-c/wit/packages/runtime/test/audit-c.test.ts`, whose transcript is `/tmp/swarm-m1-6/audit-c/witness/<name>.json`.

**What I ran.**
- The Node gate at the head: `pnpm check`, exit 0, 449 of 449 tests, `ledger ok, 934 requirements, 356 covered, 62 partial`. Transcript: `check-node.log`.
- 65 mutations, each against the whole Node suite, and two combined ones by hand. Transcripts: `mutations.log`, `mutations-b.log`, `mutations-c.log`, and one JSON report per mutation in `mut/`. Runs of `m07c` to `m07f` appear in two logs with the same result, because two runners overlapped.
- Audit A's three process harnesses, ported to the head (no lease flag, no forced expiry): `cuts/cuts.py`, `cuts/recovery.py`, `cuts/faults.py`. All three exit 0 with the same observations audit A logged.
- 15 witness tests and three process scripts (`proc/pid.py`, `proc/basedb.sh`, and the old-database check in `proc/olddb.*`).
- The Bun gate at the head: `bun --bun run check`, exit 0, 449 of 449 tests under Bun 1.4.5. Transcript: `check-bun.log`.
- I did not rerun the step probe, so the 20 percent limit rests on part 2's figures. The witnesses ran on Node 22 on macOS. The two blocking ones also ran on Bun, with the same result (`witness/w6b-on-bun.json`, `witness/w4b-on-bun.json`).

All paths below without a leading slash are under `/tmp/swarm-m1-6/audit-c/`. Source citations are `path:line` at the head commit, relative to the repository root.

## The 20 items

| # | Fixed? | Evidence | Broke the fix and saw a test fail? |
|---|---|---|---|
| 1 Every write names its flow | Yes | One check, `checkHandle`, at `packages/runtime/src/store/sqlite.ts:108`, called inside the transaction of update (`:395`), delete (`:423`), key-value (`:469`, `:477`), admit (`:489`), terminate (`:248`) and insert (`:298`, `:304`). The handle carries the flow at `packages/runtime/src/execution/thread-state.ts:192`. I derived the call sites of all 15 mutating store operations: in `src` every one goes through a handle, a flow, or the runtime itself. | Yes, five ways (`m01a`–`m01e`). Each is detected by O01 and the frozen-process CLI test, and by O03, O04, O11, O19, Q13, Q14 for their own parts. |
| 2 A holder is one process | Yes | `packages/runtime/src/platform/process-alive.ts:3`, `sqlite.ts:569`. No expiry column is left (`store/migrations/0003_claims.ts:9`). `--holder-timeout` and `holderTimeoutMs` are gone from the tree. | Yes. A dead holder never found lost (`m02a`): 6 tests fail. A permission error read as dead (`m02b`): the clock CLI test fails. A live holder found lost (`m02e`): 29 fail. The recheck inside the writer lock (`m02c`, `m02d`) is not detected by the suite, because each of its two halves covers the other. With both halves removed, the ported two-process harness `cuts/recovery.py` fails, so the recheck is real. |
| 3 `spindle recover --force` | Yes | `packages/runtime/src/cli/status.ts:45`. Transcripts of all four cases are in `proc/pid.log`. | Yes (`m03a`, `m03b`). |
| 4 A displaced process cannot keep working | Yes | `packages/runtime/src/cli/run.ts:198`, `execution/step.ts:736`, `execution/ThreadSupervisor.ts:291`. | Partly. Removing the CLI line (`m04a`) or the poll's interrupt (`m04d`) is detected. Removing the `displaced` mark on the poll path (`m04b`) or on the interrupt path (`m04c`) is not detected. The CLI test passes through the other route, a refused write. A displaced process whose tool never writes has no test. |
| 5 An abort keeps the thread | Yes for a tool. See BLOCKS 2 for a timed-out hook. | `step.ts:747`, `ThreadSupervisor.ts:369`. O06, O07. | Partly. No wait at all (`m05a`) is detected by O06. Not detected: no resume of queued work after the cleanup (`m05b`), no release of the wait on close (`m05c`), on an exiting abort (`m05d`), or on a local terminate (`m05e`). "The queued send is delivered after the cleanup" passes in O06 because the waiting sender claims the thread itself. W3 and W9 show that the resume and the close do work at the head. |
| 6 A handle expires when its callback returns | Yes | `execution/callback.ts:5`, `thread-state.ts:170`, `sqlite.ts:120`, `step.ts:390`. | Partly. A callback that never reads as finished (`m06a`) and a handle that stays valid after an abort (`m06d`) are detected. Not detected: the check at commit (`m06b`) and the inbound hook's internal owner (`m06c`). O11 and O12 pass through the flow check and the termination check instead. W10 and W11 show both fixes work at the head and fail when each is removed. They are ready to become the missing tests. |
| 7 Recovery reads runtime-owned facts | Yes | `0003_claims.ts:17`, `sqlite.ts:145`, `:153`, `:319`, `:424`, `:437`, `execution/assemble.ts:186`–`:192`, `:248`–`:252`. | Yes, six ways (`m07a`–`m07f`): O13, O14, O15, O16, O17 each fail for their own mutation. Not detected: positions lost after `filter_messages` (`m07g`, the repair at `step.ts:624`). No test combines a `filter_messages` hook with a reused call id. |
| 8 The unfenced methods go away | Yes | `store/ThreadStore.ts:182` has no `takeQueue`, `setStatus`, or `enqueue`. No source or script calls them. The mid-drain kill test passes, and `cuts/cuts.py` passes both sides of the delivery commit. | Not by mutation. The test is an interface check. |
| 9 A terminated thread takes only an injection | Yes | `sqlite.ts:121`, `:267`. O19, O20. | Yes (`m09a`: 6 fail, `m09b`: O19). |
| 10 Stop is read at every boundary | Yes | `step.ts:467`, `:595`, `:597`, `:641`, `:682`, `execution/tools.ts:118`, `execution/call.ts:391`, `:394`, `:412`, `:437`. | Yes for both stop checks together (`m10c`: Q11, Q12, Q18, Q21) and for the retry (`m10d`: Q19). Either stop check alone (`m10a`, `m10b`) is not detected, because the other one catches it. |
| 11 An unstarted call cannot become a success | Yes | `step.ts:467`–`:478`, `execution/messages.ts:171`. | Yes (`m11a`, `m11b`: Q21). |
| 12 The step cap is strict | Yes | `sqlite.ts:550`, `step.ts:295`, `:699`. | Yes (`m12a`, `m12b`: Q23). |
| 13 A refused `queueTool` commits nothing | Yes | `thread-state.ts:314`–`:336`. | Yes (`m13a`: Q26, Q27). |
| 14 Secrets in queued work | Yes | `thread-state.ts:326`, `ThreadSupervisor.ts:100`, `tools.ts:237`, `step.ts:515`, `messages.ts:165`. | Yes. No secret check (`m14a`: Q17, Q28, Q41). Raw attachments (`m14b`: Q29). No redaction of the stored call (`m14e`: Q31). An unprotected call envelope (`m14c` with `m14f`: Q30). The redaction of the stored call exists twice, and removing either copy alone (`m14c`, `m14d`) is not detected. |
| 15 An unreadable entry is set aside | Yes | `sqlite.ts:518`, `store/schema.ts:215`. Q33. | Yes, by a hang. With no quarantine (`m15a`), or with the head check counting failed rows (`m15b`), Q33 spins at 100% CPU and never ends. Not detected: the `pending` filter in `queueLength` (`m15c`), `isQueued` (`m15d`), and the dequeue (`m15e`), and the flow fence on the quarantine write (`m15f`). |
| 16 Terminate and waiting senders | Yes | `ThreadSupervisor.ts:347`, `:159`. | Yes (`m16a`: Q34 and the three-process CLI test, `m16b`: Q35). |
| 17 Small ones | Yes, with one remainder | `thread-state.ts:348`, `:317`, `execution/run-status.ts:67`, `step.ts:607`. The remainder: the text for a failed run, `run-status.ts:68`, still tells a call that never started that Spindle "does not know whether the tool finished". | Yes, all four (`m17a`: Q36, `m17b`: Q37, `m17c`: Q39, `m17d`: Q40). |
| 18 The ledger and the documents | Ledger yes. Documents partly. | All 20 of audit B's corrections are in `packages/conformance/ledger.json` with the status that part 2's report states. See "Documents". | Not applicable. |
| 19 A claim never outlives its executor | No, not as stated | The sender can no longer be interrupted between claim and start (`ThreadSupervisor.ts:222`). The executor still can be: see BLOCKS 1. | Yes for the sender's side (`m19a`: the test at `packages/runtime/test/execution/history.test.ts:311` fails). That test interrupts the sender. No test interrupts the executor. |
| 20 The caller's own secrets decide | Yes | `thread-state.ts:326` reads `state.secrets`, which is the calling handle's set. | Yes (`m14a`: Q41 fails). |

Three more mutations on the supervisor belong to no single item. The control poll no longer settling a claim of its own holder that has no execution behind it (`mx1`, `ThreadSupervisor.ts:283`): not detected. `start` no longer displacing an earlier local run (`mx2`, `:143`): not detected. A handle no longer refused once its run has ended (`mx3`, `thread-state.ts:175`): detected by Q16.

Counted over all 65: 43 detected, 22 not detected. Of the 22, six are one half of a doubled check (`m02c`, `m02d`, `m10a`, `m10b`, `m14c`, `m14d`), one had no effect on its own (`m14f`), and 15 are behaviour that no test covers.

## BLOCKS 1. An execution that is interrupted before its fiber starts leaves the thread `running` for the life of the process

**Consequence.** A thread that cannot continue. The claim is committed, the queue entry is kept, no model or tool ever runs, `send` never resolves, and every later `send` queues behind a run that does not exist. The holder's process is alive, so no observer repairs it. A second abort changes nothing.

**I ran it.** `W6b`, through the promise API of the test driver only.

```
cd /tmp/swarm-m1-6/audit-c/wit
pnpm exec vitest run packages/runtime/test/audit-c.test.ts -t "W6b"
cat /tmp/swarm-m1-6/audit-c/witness/w6b-promise-api-abort-before-start.json
```

Two variants get stuck, and one control does not.

| Variant | What the test does | 1.5 s later |
|---|---|---|
| send, then abort in the same turn | `session.send(thread, "A")`, then `await session.abort(thread)` with no turn of the event loop between them | `abort` returned `true`. Status `running`, claimed, 1 queue entry, 0 messages, 0 provider requests. The first `send` is pending. A second `send` is pending after 2 s. `settled` is pending. A second `abort` returns `true` and changes nothing. A peer's status read says `running`. |
| queueMessage, then abort | `await state.queueMessage(...)` on a thread at rest, then `await session.abort(thread)` | The same. |
| control | `send`, two `setImmediate` turns, then `abort` | The run had already finished. Everything settles. |

`W6` shows the same through `ThreadSupervisor` directly, and that the row is still `running` after the supervisor closes. `W6d` shows the way out today: a forced recovery from another session settles the thread, and the next `send` delivers both messages. The first `send` stays pending for ever.

**Why.** `start` forks the execution and returns (`packages/runtime/src/execution/ThreadSupervisor.ts:192`). Effect does not run a forked fiber at once. It schedules it for the next turn (`node_modules/effect/src/internal/effect.ts:5645`–`:5648`). All of the bookkeeping is in an `Effect.onExit` inside that effect (`ThreadSupervisor.ts:154`–`:189`): it removes the flow from `flows`, removes the entry from `live`, and completes `done`. An interrupt that arrives before the fiber's first step ends the fiber without running any of the effect (`effect.ts:608`–`:613`, then `:620`), so the `onExit` is never installed. After that:

- the flow stays in `flows`, so the control poll never takes the claim for one with no execution behind it (`ThreadSupervisor.ts:283`–`:284`);
- the entry stays in `live` with a `done` that nothing completes, so `send` waits at `:328` or `:335` and `awaitRest` waits at `:270`;
- the thread row keeps `run_state = 'running'` and the holder's process is alive, so `recover` leaves it (`store/sqlite.ts:574`).

`abort` interrupts without asking whether the fiber has begun (`ThreadSupervisor.ts:376`). So do `terminate` (`:250`), the displacement in `start` (`:146`), and the finalizer (`:304`). For those three the row is settled or the holder is dropped, so only the bookkeeping leaks.

**Who can reach it.** Any caller of the runtime's API that sends or queues to a thread at rest and aborts before the next turn of the event loop. `spindle run` can reach it only when the second Ctrl-C lands in that window, and that process then exits, so an observer settles the thread as lost. That case is not stuck.

**Is it new?** No. The fork and the `onExit` have the same shape at `d4f5b87`. I count it because its consequence is on the brief's list, and because item 19 states the invariant, "a claim never outlives the code that would run it", and its fix covers the sender's interruption only. Appendix A says "`Effect.onExit` records the outcome" (`docs/plans/m1-core-loop.md:897`), which is true only once the fiber has begun.

**Smallest fix. I tried two.**

1. Never interrupt an execution fiber that has not begun. Mark the run as begun in the first step of the forked effect, inside the `onExit`, and have `abort`, `terminate`, and the displacement in `start` skip the interrupt until then. Nothing else is needed: `abort` already sets `run.stop` (`:373`), and the loop reads it before its first drain (`step.ts:595`), so the run settles `idle` with the abort's reason. After a terminate the run's first write gets `FlowEnded`. This is 7 changed lines in `ThreadSupervisor.ts` and 1 in `thread-state.ts`. With it, `W6b` gives `idle (aborted_by_user)` for the send, the message stays queued, and the next `send` delivers both. The suite passes 449 of 449.
2. `Effect.forkIn(..., scope, { startImmediately: true })`. One line. It cures `W6b` too, but Q06 then fails: a run with no asynchronous step finishes inside `queueMessage`, and the driver's `settled` reports no run. I would not take this one without a decision about that seam.

The diff of fix 1, together with the fix for BLOCKS 2, is `/tmp/swarm-m1-6/audit-c/trial-fixes.diff`. Transcripts with it applied: `witness/w6b-with-trial-fix.json`, `witness/w6-with-trial-fix.json`, `trial-suite.log`.

**The test that would prove it.** The two stuck variants of `W6b` as a conformance scenario: after `send` then `abort` in one turn, and after `queueMessage` then `abort` in one turn, the thread is not `running`, the `send` resolves, a later `send` runs, and each message is stored once.

## BLOCKS 2. After an abort, a hook call that the runtime already timed out holds the thread `running` until the process exits

**Consequence.** A thread that cannot continue. The run status stays `running`, the aborted `send` never resolves, and every later `send` waits.

**I ran it.** `W4b`.

```
cd /tmp/swarm-m1-6/audit-c/wit
pnpm exec vitest run packages/runtime/test/audit-c.test.ts -t "W4b"
cat /tmp/swarm-m1-6/audit-c/witness/w4b-timed-out-hook-holds-after-abort.json
```

An `after_create_message` hook of the agent never settles. The hook limit is 50 ms. The runtime logs "Hook hang … did not settle within 50ms" and the run goes on into its model call, as the divergence at `packages/conformance/DIVERGENCES.md:157` promises. Then the test aborts and releases the model.

- 2 s after the abort: status `running`.
- The first `send`: pending.
- A second `send`, 3 s more: pending.
- 5 s after the abort: status `running`. One provider request in total.

**Why.** Every hook call puts its promise into the run's set (`packages/runtime/src/execution/hooks.ts:460`, `execution/callback.ts:16`–`:20`, and the set is `run.pending` at `step.ts:367` and `:385`). When the call runs past its limit, the runtime marks it expired (`hooks.ts:498`) and moves on, and the promise stays in the set. The abort path then waits for every promise in the set (`step.ts:751`–`:757`).

**Why I do not read this as the decision in part 3.** Part 3 says a tool that never returns holds its thread. A tool that never returns also keeps its own run from ending, on every path. A hook past its limit is different in three ways. The runtime has already given up on it and says so in the log. Its handle is already dead, so it can write nothing. And on the ordinary path the same run settles and a new execution starts while that hook's code may still be running, which Q-series and H15 already accept. So the hold buys no exclusion that the runtime otherwise keeps for this code. It only adds a way to lose the thread, and only after an abort. Before this round an abort freed the thread at once. If you do read it as part 3, move this finding to the follow-ups and the count is 1.

The way out today is the same as for a frozen process: `spindle recover <thread> --force` from another process, or the end of this one.

**Smallest fix. I tried it.** Drop a hook's promise from the set when the call expires. Keep the promise on the `Callback` (`callback.ts`, two lines) and delete it from `scope.pending` where `call.expired` is set (`hooks.ts:500`, one line). With it, `W4b` reads `idle` 2 s after the abort, the first `send` resolves `idle (aborted_by_user)`, and the second `send` is delivered. The suite passes 449 of 449. Diff: `trial-fixes.diff`. Transcript: `witness/w4b-with-trial-fix.json`.

**The test that would prove it.** `W4b` as a conformance scenario: a hook that ran past its limit and never settles, then an abort while the run is in a model call. The thread settles `idle` with the abort's reason, and a send that waited is delivered with no further trigger.

## Points of failure that I rechecked

Audit A found 14 of 28 checks passing. Thirteen still pass. One does not.

| Row | Now | How I know |
|---|---|---|
| 01 Send | Holds | Reran. `cuts/cuts.py`, the three admit and release cuts, with SIGKILL on each side of COMMIT. The outcomes are absent, queued once, and settled, as audit A logged. `cuts/cuts.log`. |
| 04 Claim | Holds | Reran. The admit cut returns either the old settled row or one running claim with one queued input. A database made by the parent version, with its row set to `running` by hand, is migrated and settled `failed execution_lost` with its rows kept: `proc/basedb.log`. |
| 07 FIFO and routing | Holds | In the gate (Q06, Q09, Q40). Re-derived: every selection orders by `seq` and reads `pending` rows only (`sqlite.ts:308`, `:507`, `:514`, `:522`, `:539`, `:552`). No other query reads the queue. |
| 10 History snapshot | Holds | In the gate (M5, M8b–M8d). The round edited those tests to take handles from the session, because a hook's handle now expires. The read is unchanged (`sqlite.ts:343`). |
| 11 Partial response | Holds | Reran the full-disk fault at the assistant insert: `cuts/faults.log`, the same four lines as audit A's. |
| 15 Settlement and release | Holds | Reran. Kill before the release COMMIT keeps `running` with its claim. Kill after it keeps `idle` with none. A full disk at the release settles `failed step_error` and a follow-up runs. |
| 16 Competing recovery | Holds | Reran `cuts/recovery.py` in both orders. A stale repairer changes nothing of the successor. With the recheck inside the transaction removed, the harness fails, so it measures the right thing. |
| 17 Status presentation | Holds | In the gate (R15, R16). The CLI lines are in `proc/pid.log`. |
| 19 Stop during tool | Holds | In the gate (Q12). |
| 22 Repeated terminate | **No longer holds** | `W1`. Audit A saw two sessions terminate one idle thread and both promises fulfil. Now the second one rejects with `ThreadTerminated`. So does a second call on the same handle, and so does any handle that was made before the first terminate. Only a handle made after it resolves. The cause is the termination check for handles at `sqlite.ts:246`–`:250` with `:121`, and the handle's captured value at `thread-state.ts:194`. Row 22 does not block by the brief's gate, so this is a follow-up. |
| Combined 1, Y acted | Holds | Reran in `cuts/recovery.py`: the prefix is intact, Y and Z each get one error result, and the tool log stays `echo X`, `Y`. |
| Combined 3, two repairers | Holds | Reran, both orders. |
| Combined 4, terminate inside a create | Holds | In the gate (Q16, O04, O12). I did not rerun audit A's own witness. |
| Combined 5, failed drain | Holds | By reading. The transfer of one entry per insert is unchanged (`sqlite.ts:306`). I did not rerun audit A's witness. |

The rows that failed for audit A and that the round set out to fix (02, 03, 05, 06, 08, 09, 12, 13, 18, 20, 21, and combined 2 and 6) are covered by the item table. Row 14 is part 3.

**The questions in the brief that are not findings.**

- *The control poll.* Each poll reads every `running` thread in the database joined to its holder, probes one process id per row, reads this holder's claims, and settles a claim of this holder that has no execution here (`ThreadSupervisor.ts:279`). The probes are not grouped by process id. `W7` measured one poll at 0.07 ms for 1 running thread, 0.27 ms for 100, 1.8 ms for 1,000, and 7.9 ms for 5,000, which is 3% of the period. Every query uses an index. The plans are in `witness/w7-control-poll-cost.json`.
- *A remote terminate between two polls.* The terminate settles the row in its own transaction. From then on every write of the old execution is refused at commit. The old execution stops at its next write, or at the next poll, at most 250 ms later, whichever comes first. A model call in flight goes on until then. One tool can be entered in that window, and its writes are refused.
- *The `disposition` column.* Six statements read pending work and all six filter on it. Three of the six filters have no test (`m15c`, `m15d`, `m15e`).
- *A row from before the migration.* A message with no `flow_id` is paired by call id as before (`assemble.ts:191`, `:251`), and its delete cascade is the old one (`sqlite.ts:438`). Recovery closes no call of such a row. The parent version never stores `running`, and the head before this round did not close such calls either, so nothing is worse.
- *A database from an earlier build of this PR.* It cannot be opened: `spindle: Failed to prepare statement`, with no hint (`proc/olddb.*`). The migration was edited in place, as the work list allows.

## Documents

**A sentence that still describes a lease.** One, in the two rewritten places: `docs/plans/m1-core-loop.md:913`, "because the lease renewal also interrupts a run that another process settled". `packages/conformance/DIVERGENCES.md` has none. Outside the rewritten sections, the plan's own M1-6 task text still does (`docs/plans/m1-core-loop.md:435`, `:441`, `:442`, `:450`, `:451`).

**Sentences that claim more than the code does, or that are out of date.**

1. `docs/plans/m1-core-loop.md:920` says the ledger holds 368 `covered` and 50 `partial`. The gate reports 356 and 62.
2. `docs/plans/m1-core-loop.md:902`–`:911` give live lanes at `37c64f1` and a step cost of 14.2% and 12.8% above the parent. Those are the head before this round. Part 2's report measured 15.7% and 15.0% for this one, and the plan does not say so.
3. `docs/plans/m1-core-loop.md:886` and `packages/conformance/DIVERGENCES.md:168` say `injectMessage` "still works on a terminated thread". It works only from a handle made after the termination. Decision 9 is recorded in neither file: an update, a delete, and a key-value write from outside are refused, and so is every handle from before the termination. Item 18 asked for each new choice to be recorded.
4. Not recorded anywhere: a call that a stop kept from running skips `after_tool_call_failure` and `before_store_tool_result` (`step.ts:470`–`:478`). Hooks section 5 runs the branch hook by outcome. The plan says only that the call "gets an error result" (`:883`).
5. `docs/plans/m1-core-loop.md:883` and `DIVERGENCES.md:161` say an abort keeps the claim "while a callback is still running". They do not say that a hook past its time limit counts (BLOCKS 2).
6. `docs/plans/m1-core-loop.md:897`: see BLOCKS 1.
7. `docs/design/thread-ownership.md:1` says the first section is built in PR 8. That is true of every decision except for the two blocking findings, which are gaps in decision 5 and in work-list item 19.

**The ledger.** I checked all 20 corrections against `packages/conformance/ledger.json`. Each has the status in part 2's table, each `partial` has a reason, and each test it names exists and passes. Three test names in `packages/runtime/test/store/contract.test.ts` (`:99`, `:915`, `:942`) still say `setStatus`, `enqueue`, and `takeQueue`, and the ledger cites them. `0953e887` and `e28dedf2` are `covered` on O01, O03, O06, and O07. That evidence is about tools. A hook past its limit can still run beside a later execution on the ordinary path, which is older than this round.

## Decisions I would look at again

These are decisions, so they are not findings.

- **The process identity domain was left out. One case inside it is cheap and certain.** When the holder row's process id is the observer's own, and the holder id is not one this process registered, that holder is dead. Today the observer says the thread is running "in process N", where N is itself, `spindle recover` says that process is alive, and `spindle send` waits for ever (`proc/pid.log`, case b). This is the ordinary case in a container, where the runtime has the same process id on every start. A crash there leaves every thread that was running stuck until someone runs `recover --force`. A process-wide set of the holder ids that this process registered would decide it with no boot id.
- **The probe reads a process id of 0 or -1 as alive, and a killed process that its parent has not reaped as alive** (`proc/pid.log`, cases d1, d2, e). No runtime path writes 0 or a negative id. The unreaped case is real under a parent that does not reap.

## Follow-ups

1. A second `terminate` rejects with `ThreadTerminated` unless its handle was made after the first one (`W1`, `sqlite.ts:246`). Point 22 regressed.
2. `HandleExpired` and `CallerHasOpenCalls` carry no message, so a tool that lets one escape is stored as `Tool user threw: ` with nothing after it (`W5`, `store/ThreadStore.ts:152`, `:166`).
3. An abort is followed at once by an execution of whatever the queue holds, including work queued before the abort, so an abort cannot stop a tool that queues itself (`W3`, `step.ts:764`, `ThreadSupervisor.ts:176`). Decision 5 says so, and I doubt it was meant for work queued before the abort.
4. Fixes with no test that proves them: the commit-time expiry check and the inbound hook's owner (`W10` and `W11` are ready), the `displaced` mark, the resume and the three releases of the abort wait, positions after `filter_messages`, three `pending` filters, the flow fence on the quarantine write, the poll's settlement of a claim with no execution, and the displacement in `start`.
5. `spindle recover` on a thread that does not exist prints `ERROR (#2): ThreadNotFound:` with a stack. The command and its flags have no description in `--help` (`cli/status.ts:45`).
6. The closing text of a failed run still says Spindle "does not know whether the tool finished" for a call that never started (`execution/run-status.ts:68`).
7. `toQueued` checks only the role and the content, so a row whose `attachments` is not an array is stored as a message and fails that run with `fatal_error` (`W12`, `store/schema.ts:215`). The next send works.
8. Nothing reads a `failed_delivery` row. `spindle status` counts pending rows only, and the rows are never removed.
9. A holder row of a process that was killed is never deleted (`sqlite.ts:594`).
10. Deleting a tool result reopens its call. The next request of that run carries the call with no result, and settlement stores an error that says the execution was aborted, after the final reply (`W8`). This is older than the round.
11. The refusal of item 14 has no length floor and counts every value the code read with `env()`, so a short value refuses unrelated arguments, and the error names neither the variable nor the path (`thread-state.ts:244`, `:326`). By reading.
12. A secret passed as a number or a boolean in queued arguments is not refused (`execution/redact.ts:31`). `DIVERGENCES.md:151` says this for redaction and not for the refusal. By reading.
13. `appendMessages` and an `insertMessage` with no flow check neither the handle nor the flow. Only scripts and tests call them (`sqlite.ts:263`).
14. A hook's handle does not inherit the expiry of the hook that caused it, so a nested hook can still write after its parent timed out, while the run goes on (`thread-state.ts:170`). By reading.
15. `processAlive` logs a warning on every poll for every thread when the probe fails with an unexpected error (`platform/process-alive.ts:12`). By reading.
16. Three test names still name the removed methods (`test/store/contract.test.ts:99`, `:915`, `:942`).
17. I did not rerun the step probe.

## Maintenance list

The worst structural problems the round introduced, for the operator's review. No rewrites proposed.

1. **"This run lost its thread" is decided in four places.** `run.displaced` is set at `ThreadSupervisor.ts:144`, `:293`, and `step.ts:763`, the loop decides again from `terminated` at `step.ts:336`, and `onExit` decides a third time from the stored status at `ThreadSupervisor.ts:161`–`:174`. Two of the three marks have no test.
2. **`Run` is now a bag of six mutable signals between two modules** (`thread-state.ts:30`–`:42`): `pending`, `releaseWait`, `waitForCallbacks`, `displaced`, `resumeQueued`, `ended`. `step.ts:764` sets `resumeQueued` so that `ThreadSupervisor.ts:176` can read it after the fiber ends.
3. **The `onExit` in `start` does four jobs** (`ThreadSupervisor.ts:154`–`:189`): bookkeeping, rebuilding an outcome from the store, classifying a displacement, and claiming and starting the successor. BLOCKS 1 is what happens when it does not run.
4. **The abort wait is released from five call sites** (`ThreadSupervisor.ts:145`, `:249`, `:294`, `:302`, `:375`), and four of them have no test.
5. **The ownership check is spelled three ways in the store.** `insertMessage` compares the flow itself and then calls `checkHandle`, which compares it again (`sqlite.ts:298`, `:304`). `terminate` and `admit` call `checkHandle` inline. Update, delete, and key-value go through `guardWrite`. `appendMessages` has its own termination check (`:267`).
6. **Two things are done twice so that each hides the other from the tests.** The stop check before a tool (`step.ts:467`, `tools.ts:118`), and the redaction of a queued call (`step.ts:515`, `messages.ts:165`). The `notRun` object is compared by identity across the two modules (`step.ts:468`).
7. **`createMessage` now holds per-writer policy** (`messages.ts:164`–`:179`): the queued rebuild and the skipped restore sit between the hooks and the insert, next to id checks and the retry on a taken id.
8. **Pairing rides on a `WeakMap` keyed by object identity** that the store interface file exports (`store/ThreadStore.ts:171`). It is written at `store/schema.ts:151`, `execution/history.ts:49`, and `step.ts:628`, and `callerSequence` throws when an object was copied on the way (`ThreadStore.ts:173`).
9. **`recover` serves three callers through one optional id and one boolean** (`sqlite.ts:569`): a status read, the poll over every thread, and the operator's force. `recover(undefined, true)` would settle every running thread in the file. The store's SQL module now also does process I/O (`sqlite.ts:5`).
10. **The loop spins without yielding when settlement says "continue" and the drain delivers nothing.** No such case exists at the head, but the two queries must keep agreeing (`sqlite.ts:551`, `:522`), and under `m15a` and `m15b` the suite did not fail, it hung at 100% CPU. `nextQueued` also takes an optional flow that only `scripts/store-fixtures.ts:11` omits.

## Where the evidence is

Everything is under `/tmp/swarm-m1-6/audit-c/`.

- `check-node.log`: the gate at the head.
- `mutate.py`, `mutations.log`, `mutations-b.log`, `mutations-c.log`, `mut/`: the mutations.
- `wit/packages/runtime/test/audit-c.test.ts`: the witness tests. `witness/*.json`: what each one recorded. `witness-run*.log`: the runs.
- `cuts/`: audit A's harnesses ported to the head, with `cuts.log`, `recovery.log`, `faults.log`.
- `proc/pid.py` and `proc/pid.log`: the process id probe. `proc/basedb.sh` and `proc/basedb.log`: the parent-version database.
- `trial-fixes.diff`, `trial-suite.log`, `witness/*-with-trial-fix.json`: the two trial fixes.
- `src`, `src2`, `src3`, `wit`: scratch copies of the head. None is the repository.
