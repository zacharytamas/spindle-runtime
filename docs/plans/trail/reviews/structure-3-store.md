BLOCKS: 2 · SHOULD FIX: 6

# Review 3: PR 13, `m1/10-store`, "split the store into three services with one ownership check"

Head `23503f7bbdb1ced959a38f85897e67067895b874`, base `38c421c`. Paths are relative to `packages/runtime/` at the head unless they say "base". I changed nothing in the repository and posted nothing. `git status` is clean. Everything I wrote is under `/tmp/structure/review-3/`.

## Verdict in short

The ownership check, the transactions, the message positions, recovery and the history cache behave as they did. I could not make the store answer differently through any of them. A replay of 16,000 seeded store operations gives the same result, the same typed error, the same error text and the same stored rows on the base and on the head, on Node and on Bun.

Two things do behave differently, both at the edges, and both count as `BLOCKS` under the rule in the brief. One is undisclosed: the attachment check now throws Effect's own error where it used to let the caller's error through. The other is disclosed in the implementer's table but is still a change: a holder whose row cannot be deleted is now forgotten by the process, so its threads are recovered as lost where they used to stay running.

The structure is better than before. The restructuring also added one cost that grows with thread length, about 1 ms per step at 5,000 messages on Node and about 2 ms on Bun, and it left its own headline property (pairing survives a hook that copies messages) without a test.

## BLOCKS

### B1. The attachment check replaces the caller's error with Effect's own

- **What changed.** `isAttachmentRef` is now `Schema.is(...)` (`src/store/schema.ts:214-215`). It is used on values that user code hands in, not only on decoded queue rows: `src/execution/ThreadSupervisor.ts:97` (`queueMessage`), `src/execution/hooks.ts:126` and `src/execution/hooks.ts:267`. When reading a property throws, `Schema.is` throws a new plain `Error` with the text `Type guard adapter can only return false for schema issues` and puts the original inside a `Cause` in `cause` (`node_modules/effect/dist/SchemaParser.js:141-168`). The base predicate read the fields directly and let the original error through.
- **Witness, run on Node and on Bun.** `state.queueMessage({ role: "user", content: "x", attachments: [a] })` where `a.size` is a getter that throws `new Error("boom")`. Base rejects with `boom`. Head rejects with `Type guard adapter can only return false for schema issues`. A custom error class is lost too: `error instanceof Mine` is true at the base and false at the head, and `error.cause` is a `Cause`, not the error. Files: `witness-shared.test.ts`, `witness-base-node.json` against `witness-head-node.json` (the only differing row of 29), `exp2-cause.ts`.
- **Size of it.** Narrow. It needs an attachment object with a throwing accessor. On every other value I tried the two predicates agree: 37 other live values (class instances, inherited properties, null prototype, proxies, explicit `undefined`, `-0`, `2^53`, boxed numbers) and 56 queue payloads, in `exp1-validators.ts`.
- **Smallest fix.** Keep `Schema` for the decoded queue payload and restore the eleven-line hand-written predicate for the exported `isAttachmentRef` (base `src/store/schema.ts:217-227`). Or accept the new text and record it as a departure, since the report says no error text changed.

### B2. A holder whose row cannot be deleted is forgotten anyway, so its threads are recovered

- **What changed.** At the base `dropHolder` removed the id from the process-wide set only after the `DELETE` succeeded (base `src/store/sqlite.ts:629-634`), and the supervisor ignored a failure (base `src/execution/ThreadSupervisor.ts:307`). At the head the release ignores the `DELETE` failure and then removes the id regardless (`src/store/RunStore.ts:265-269`). The implementer's table says so under S8. It is still a change in what gets stored.
- **Witness, run on Node and on Bun.** A trigger makes `DELETE FROM holders` fail. A holder with this process's id holds a running thread. After the release, the holder row is still there on both. Base: `recover(thread)` returns nothing and the thread stays `running`. Head: `recoverLost(thread)` returns the thread and it is stored as `failed` with `execution_lost`. Files: `witness-base.test.ts`, `witness-head.test.ts`, `witness-holder-{base,head}-{node,bun}.json`.
- **Size of it.** Narrow, and the new outcome is arguably the right one, because the supervisor that held the thread is gone. It is reachable only when the delete fails and the thread was not settled first.
- **Smallest fix to keep the old behavior.** Remove the id only when the delete succeeded: `Effect.ignore(Effect.tap(sql\`DELETE ...\`, () => Effect.sync(() => localHolders.delete(holder.id))))`. Or keep the new behavior, say in the PR body that this one outcome changed, and add a test, because none guards either behavior (the mutation that keeps the id in the set passes all 505 tests).

## The mutating operations

"Ambient" means the `WritingHandle` reference that the base read from the fiber. Base lines are in base `src/store/sqlite.ts`.

| Operation | Check at the base | Check at the head | Same |
|---|---|---|---|
| `createThread` | None. The parent must exist (base 224). | None. The parent must exist (`src/store/ThreadStore.ts:17`). | Yes |
| `setValue` | `requireThread`, then `guardWrite` on the ambient handle (base 489-509). | `selectRun`, then `authorize(origin)` (`src/store/ThreadStore.ts:53`). | Yes. `ValueNotJson`, then `ThreadNotFound`, then the refusal, as before. |
| `insertMessage` | `options.flowId` against the thread, then `checkHandle(ambient, injection)` (base 303-314). | `authorize(origin, "insert")` (`src/store/MessageStore.ts:49`). | Yes. The base checked the flow twice with one value, because the handle and the options took the flow from the same `owner` (base `src/execution/thread-state.ts:193`, `242`). |
| `updateMessage` | `guardWrite` (base 421). | `guardWrite(origin)` (`src/store/MessageStore.ts:161`). | Yes |
| `deleteMessage` | `guardWrite` (base 449). Open calls found by a join on `threads.flow_id`. | `guardWrite(origin)` (`src/store/MessageStore.ts:184`). Open calls found by the flow of the locked row (`:186`). | Yes |
| `admit` | `checkHandle(ambient)` (base 515). | `authorize(origin)` (`src/store/RunStore.ts:125`). | Yes |
| `claim` | A terminated thread gives `false` (base 531). | `authorize(row, external)` used as a test for termination (`src/store/RunStore.ts:143`). | Yes |
| `terminate` | Already terminated returns the time first, then `checkHandle` when a handle is present (base 254-260). | Same order, `authorize(origin)` (`src/store/RunStore.ts:110-112`). | Yes |
| `settle` | `row.flow_id !== flowId` gives `superseded` (base 573). | `authorize(..., "owner")` used as that test (`src/store/RunStore.ts:195`). | Yes |
| `nextQueued`, quarantine | One `UPDATE ... AND EXISTS (flow)` (base 555). | A write transaction that reads the run row, tests the flow, then updates (`src/store/RunStore.ts:165-171`). | Yes in result. See note 1. |
| `recover(id?)` | No ownership check. Liveness of the holder (base 595-618). | `recoverLost(id?)` (`src/store/RunStore.ts:218-238`). | Yes |
| `recover(id, true)` | As above with `force`. | `recoverThread(id, force)` (`src/store/RunStore.ts:240-256`). | Yes |
| `registerHolder`, `dropHolder` | None. | `acquireHolder` (`src/store/RunStore.ts:258-272`). | No, when the delete fails. B2. |
| `appendMessages` | Termination only, no fence (base 272-291). | Removed. A fixture builds it from `insertMessage` (`scripts/store-fixtures.ts:41-61`). | No production caller at either commit. |

No operation lost its check and none gained one.

**Callers and the origin they pass.** I read every caller. None passes the wrong origin.

- A handle builds one origin from its owner and its own expiry (`src/execution/thread-state.ts:197-200`) and passes it to `setValue` (`:358`), `deleteMessage` (`:288`), `queueMessage` (`:289`), `queueTool` (`:340`), `terminate` (`:351`), and through the write context (`:247`) to `insertMessage` (`src/execution/messages.ts:185-196`) and `updateMessage` (`src/execution/messages.ts:229`).
- The loop passes `{ flowId }` for its own writes (`src/execution/step.ts:384`), for settlement (`:293`) and for the queue head (`:567`).
- The supervisor passes `external` for a human send (`src/execution/ThreadSupervisor.ts:342`) and the caller's origin for a handle's admission (`:238`) and termination (`:254`). The orphan sweep settles with `{ flowId }` (`:294`).
- At the base a fork had to clear the ambient reference (base `src/execution/ThreadSupervisor.ts:152`). Nothing is inherited now, so there is nothing to clear.

**Former callers of `recover`.**

| Base | Head | Same |
|---|---|---|
| `cli/status.ts:23`, `recover(thread)` | `src/cli/status.ts:25`, `recoverLost(thread)` | Yes |
| `cli/status.ts:59-76`, a transaction of `getThread`, `holderOf`, `recover(thread, force)` | `src/cli/status.ts:60`, `recoverThread(thread, force)` | Yes. The five messages are the same text. Four are pinned by `test/cli/ownership.test.ts`. "had no recorded holder" is not pinned, and I reasoned it. |
| `cli/chat.ts:110-125`, `recover(id)` inside a transaction after the agent and termination checks | `src/cli/chat.ts:115-134`, `recoverThread(id, false, check)` | Yes |
| `ThreadSupervisor.ts:131`, `229` | `src/execution/ThreadSupervisor.ts:135`, `232`, `recoverLost(threadId)` | Yes |
| `ThreadSupervisor.ts:282`, `recover()` | `src/execution/ThreadSupervisor.ts:289`, `recoverLost()` | Yes |

## What I ran for point 1

1. **A seeded replay of the store.** 40 seeds of 400 operations each against the base store and the head store, with adapters that spell each origin the way each commit's `createMessage` and `thread-state` did. It covers eleven mutating operations (all but `recoverThread` and the holder release, which the CLI tests and the witnesses cover), four kinds of origin, expired handles, handles from before and after a termination, stale flows, corrupt queue rows, dead and live holders, and reads of history, positions, pages, the cursor, the queue and key-value data. It compares every result, every error tag and text, and a dump of all five tables. **18,114 lines per runtime, 0 differ, on Node and on Bun.** About 7,300 refusals are in there: `FlowEnded`, `ThreadTerminated`, `MessageIdTaken`, `HandleExpired`, `ValueNotJson`, `MessageNotFound`, `QueueEntryGone`. Files: `diff-ops.ts`, `diff-base.test.ts`, `diff-head.test.ts`, `diff/`, `diff-compare.mjs`, `diff-stats.mjs`.
2. **Handles around a termination, through the public `ThreadState`.** 29 outcomes, identical on both commits and both runtimes except the row of B1.
3. **Atomicity, head, Node and Bun** (`witness-atomic.test.ts`). With a trigger that makes the release of the claim fail, `settle`, `terminate`, `recoverThread(force)` and `recoverLost` each fail and leave the thread row, the messages and the queue exactly as they were, so the closing results are rolled back with the release. With a trigger that makes the message insert fail, and again with an unstorable value, a delivery keeps its queue entry. With a trigger that makes the claim fail, an admission queues nothing.
4. **Positions** (`witness-filter.test.ts`, `witness-head.test.ts`, Node and Bun).
   - Scenario O16 with a `filter_messages` hook that returns `structuredClone` copies, and again with spread copies, pairs each result with its own caller. It passes on the base and on the head.
   - A row written the way migration 0001 wrote it, with no `caller_seq` and no `flow_id`, reads back with a null caller sequence and its delete takes its result with it by the legacy rule.
   - The other readers are unchanged: the delete cascade and recovery read `caller_seq` in SQL (`src/store/MessageStore.ts:197-209`, `src/store/RunStore.ts:38-67`), and the loop passes the sequence that the insert returned (`src/execution/step.ts:526`, `544`, `664`, `676`).
   - Positions now exist for every message, where the base kept them only for callers and results. I traced `src/execution/assemble.ts:185-294` and the extra entries are never looked up, because no stored result names a message without calls. The replay and the conformance suite agree.
5. **The history cache** (`witness-head.test.ts`). A read and an insert inside a transaction that rolls back, plain and as a savepoint, leave no message and no position. A snapshot handed out earlier keeps its own map after a later insert.
6. **Tests.** The assertion lines of `test/store/messages.test.ts` (41) and `test/store/threads.test.ts` (3) are identical once the service names are normalised. `test/store/history.test.ts` differs only by line wrapping and the added positions map. I read the other changed tests one by one. The queue peek, the scoped holder and the moved `startRun` and `settleRun` fixtures assert what they asserted.
7. **Mutation.** 63 one-line breaks of the head, each against the full Node suite. 39 are caught and 24 pass all 505 tests. Full list in `mutants-summary.txt`.

**Properties that no test in the repository guards.** Each of these mutations passes all 505 tests. None is a regression of this PR except where marked, because the base had the same assertions.

- That `settle`, `terminate`, `admit`, `updateMessage`, `deleteMessage` and `recoverThread` are each one transaction. Only delivery is guarded. My witness in 3 catches the first three and `recoverThread`.
- That positions survive a `filter_messages` hook that replaced the message objects. **New in this PR's design, and it is the title of commit `8a4b456`.** My witness in 4 catches it.
- That the history cache records the position of the execution's own insert (`src/execution/history.ts:51`), and that an insert returns its caller sequence. **New in this PR.**
- That an expired handle is refused at commit (`src/store/database.ts:42`). The check before the call in `thread-state.ts` gives the same error first.
- That only the owning flow may quarantine a bad queue entry (`src/store/RunStore.ts:168`).
- That `recoverLost` checks loss again inside its transaction, and settles only the flows it first saw lost.
- That a released holder leaves the process set (`src/store/RunStore.ts:268`). **New in this PR.**
- That any store call but `history` is kept from yielding. See S6.

## SHOULD FIX

**Is the structure better (point 2).** Yes. The three services have clear jobs and the method lists say what they are. The ambient reference, the `WeakMap`, the throwing lookup, the hook-copy repair loop, the unfenced batch insert and the "force everything" call are gone, and the holder is scoped. I agree that no large saving is available without changing what rows decode to or what errors say. Two things about the count, though. The 77 lines saved are the 88-line service interface that was deleted (base `src/store/ThreadStore.ts:190-277`). The implementation itself grew by 28 lines, from 985 to 1,013. And about 20 to 30 lines can still go: the `check` callback (S4), the `"owner"` mode (S2), `holderOf` on a general helper (note 5), and the `unyielding` line repeated 27 times (S6).

### S1. Every step now pays a cost that grows with thread length

- **Where.** `src/store/MessageStore.ts:92` builds an Effect `HashMap` of every message on a whole read. `src/execution/assemble.ts:193`, `256` and `277` look each message up in it by id, two to three times per message, on every request assembly.
- **Measured.** Assembly of 5,000 messages: Node 2.2 ms at the base, 3.0 ms at the head. Bun 1.2 ms, 2.2 ms. Same output. Building the map on a whole read adds 1.3 ms on Node and 2.1 ms on Bun. End to end with `scripts/step-probe.ts`, 200 steps, five interleaved rounds, median per step:

  | Earlier messages | Node base | Node head | Bun base | Bun head |
  |---:|---:|---:|---:|---:|
  | 0 | 7.47 ms | 7.30 ms | 7.00 ms | 6.72 ms |
  | 2,500 | 7.98 ms | 9.04 ms | 7.18 ms | 7.81 ms |
  | 5,000 | 10.08 ms | 11.27 ms | 7.33 ms | 9.55 ms |

  Five rounds is a small sample and the ranges overlap at 2,500. The direction is the same in every pair, and nothing differs on an empty thread, so the spans that `Effect.fn` adds are not the cause.
- **Why here.** The implementer measured statements, not time, and statements did not change. The operator's standing rule is to guard only against cost that grows with thread length, and this is that kind.
- **Fix.** Look each message up once per assembly, and key by a native `Map`. 10,000 lookups by message id take 0.96 ms in the Effect `HashMap` and 0.22 ms in a `Map` on Node, 0.71 ms and 0.06 ms on Bun (`scripts/review3-bench2.ts` in the scratch head). The persistent map buys sharing on insert, which costs nothing either way at these sizes. An array of positions aligned with `messages`, with a by-id map built only when a hook returned a different array, would remove the lookups from the usual path altogether.

### S2. `authorize` is used as a yes or no test in three places, and its `"owner"` mode changes nothing

- **Where.** `src/store/database.ts:34`, `45`. `src/store/RunStore.ts:143`, `168`, `195`.
- **What is wrong.** `claim`, `settle` and the quarantine do not refuse with an error. They build a `FlowEnded` or `ThreadTerminated` only to test whether it exists. The `"owner"` mode exists for two of them, to skip the termination check. That check cannot fire there: a terminated thread never has a flow, because `terminate` releases it in the same transaction (`src/store/RunStore.ts:113-115`). Removing the mode passes all 505 tests.
- **Fix.** Write `row.flow_id !== origin.flowId` in `settle` and in the quarantine, and `row.terminated_at !== null` in `claim`, as the base did. Drop `"owner"`. `authorize` then serves the six operations that refuse with a typed error, and its last parameter is one flag for inserts.

### S3. `WriteOrigin` makes the most privileged origin the empty object, and the insert mixes who writes with what is linked

- **Where.** `src/store/model.ts:145-150`, `161-165`. `src/execution/messages.ts:185-193`.
- **What is wrong.** Both fields of `WriteOrigin` are optional and `external` is `{}`. An origin that forgot its flow or its handle is an external origin, with no help from the type. The quality review that asked for this work named exactly that hazard for the old default of `undefined`, and sketched a tagged union. Callers are right today and the tests do catch a caller that forgets: of 13 mutations that drop an origin or part of one, 11 fail the suite, and the 2 that pass both concern expiry. `InsertOptions` then intersects the origin with `callerSeq` and `dequeue`, and `createMessage` assembles the result with a conditional that reads the flow twice.
- **Fix.** A union with a `kind`, so `external` is a deliberate value and a handle cannot lose its fields. Pass the link as its own argument: `insertMessage(threadId, message, origin, { callerSeq, dequeue })`. The conditional in `messages.ts` goes away.

### S4. `recoverThread` takes a callback that one caller sets, and returns an unnamed union

- **Where.** `src/store/RunStore.ts:240-256`. `src/cli/chat.ts:115-134`. `src/cli/status.ts:60-78`.
- **What is wrong.** The third parameter is a generic effect with its own error and requirement types, there so chat can check the agent and the termination before recovery writes. Chat already wraps the call in `threadStore.transaction`. If the checks run after the call and fail, that transaction rolls the receipts back. The result has three shapes told apart by `kind`, declared nowhere, and the `alive` shape types `pid` as nullable although a live holder always has one, so `status.ts:71` could print `process null` as far as the types know.
- **Fix.** Drop the callback and return the thread in the result. Name the type, with `pid: number` on `alive`. Chat does its two checks on the returned thread inside the transaction it already has.

### S5. Nothing tests that pairing survives a hook that copies the messages

- **Where.** `src/execution/step.ts:623-627`.
- **What is wrong.** This is what commit `8a4b456` says it delivers. Passing an empty map whenever `filter_messages` returned a different array passes all 505 tests. So does leaving the position out of the cache on an insert.
- **Fix.** Add scenario O16 with a cloning `filter_messages` hook. `witness-filter.test.ts` is that test, runs against the Spindle driver as it is, passes on Node and Bun, and fails with that mutation. Add one assertion on `history.read` positions after an own insert, as in `witness-head.test.ts`.

### S6. The no-yield guard is now written out 27 times and tested once

- **Where.** `src/store/database.ts:16-17`. Applied in `ThreadStore.ts` (5), `MessageStore.ts` (10) and `RunStore.ts` (12). The test is `test/store/claims.test.ts:439`.
- **What is wrong.** At the base one wrapper covered every member by construction. The typed combinator is the right replacement and all 27 applications are present and in the right order. But the test still exercises only `history`. Removing the guard from `getMessages`, `insertMessage`, `admit` or `transaction` passes all 505 tests, so the next method added without it will not be noticed.
- **Fix.** Extend that test to loop a call from each service in the busy fiber, including one write and one `transaction`.

## Effect usage (point 3)

Checked against the installed 4.1.5 declarations and sources.

- **`Layer.effectContext`** (`node_modules/effect/dist/Layer.d.ts:1287`) takes an effect of a `Context` and is the right tool. The pragmas and migrations run once and one client feeds three services (`src/store/sqlite.ts:24-38`).
- **`Effect.fn(name)(body, ...pipeables)`** applies the pipeables in order and wraps the span around the result (`node_modules/effect/dist/internal/effect.js`, `makeFn`). So `(body, sql.withTransaction, unyielding)` is the guard around the transaction around the body, which is what the base had. Every transactional operation has both. Where the transaction is taken inside the body (`setValue`, `insertMessage`, the quarantine, `recoverLost`), the guard is still outermost.
- **`Effect.acquireRelease`** captures the context where it is evaluated and provides it to the release (`internal/effect.js:1918`). The guard wraps the whole `acquireRelease`, so the release runs with yields prevented. I reasoned this from the source and did not observe it. The acquire is uninterruptible, and the supervisor's finalizers run in the same order as before: interrupt the executions, release the holder, close the poll.
- **`Schema`.** `Schema.is` on a `Struct` ignores extra keys and accepts an explicit `undefined` for an optional field, and the decoder returns the parsed payload itself, so unknown fields and an own `__proto__` key survive. `Schema.Natural` agrees with the old count check on every value I tried. The one difference is B1.
- **`pnpm exec effect-tsgo tsc --noEmit -p tsconfig.json`** exits 0 with 11 suggestions. None is under `src/store/`. That matches the report.

## Does it serve the next pull requests (point 4)

**The run state machine.** Mostly helped. Ownership no longer travels in the fiber, so a state machine can hand out origins as plain values and the store will check them. `acquireHolder` already has the lifetime a machine wants. Three things stand in the way.

- `settle` decides `continue`, `capped`, `settled` or `superseded` from two booleans (`src/store/RunStore.ts:192`, `199-212`). That is part of the machine living in the store. The machine PR should pass one typed event and get one typed outcome. I would not change it in this PR.
- The outcomes of `settle`, `terminate` and `recoverThread` have three unrelated shapes: a string, a number, and an unnamed union. Naming the recovery outcome now (S4) keeps the machine PR from inventing it.
- The handle's `expired` closure reads four fields of the `Run` bag (`src/execution/thread-state.ts:174-183`). That is fine as a seam. A tagged origin (S3) lets the machine own which states may write.

**Three typed hook kinds.** Neutral. The store does not know about hooks. The write context carries `call` and `origin` side by side (`src/execution/messages.ts:20-30`), and a tagged origin would let a hook kind say which origins it may hold.

**Splitting the message write in two.** This is where the interface is in the way. `createMessage` prepares a message and then commits it, and the commit takes one object that is the origin, the caller link and the queue entry at once (S3). A split wants `prepare` to know nothing of the store and `commit` to take `(origin, link)`. Separate them now and that PR only moves code.

**What I would change now.** S3 and S4, because both alter signatures that the next PRs will otherwise change again. S2, because it leaves `authorize` as the one place that refuses. S1, before the cost is built on.

## Notes

1. The quarantine of a bad queue entry was one `UPDATE` and is now a write transaction of a read and an update (`src/store/RunStore.ts:165-171`). The result is the same in the replay (25 quarantined rows). It adds three statements on that path only. I count this as a transaction added around one atomic statement, not a boundary moved. Say so if you read it otherwise.
2. The service contracts are now inferred from the SQLite implementation (`ReturnType<typeof make...>`). The error channels and the per-method comments of the old interface are no longer written anywhere.
3. `ThreadStore.ts`, `MessageStore.ts` and `RunStore.ts` hold the SQL, and `sqlite.ts` is 38 lines of wiring. The file names suggest the opposite.
4. `transaction` lives on `ThreadStore`, and its one production use spans `RunStore` and `MessageStore` (`src/cli/chat.ts:115`).
5. `holderOf` reads through the general `heldRows` helper with a left join and two null tests (`src/store/RunStore.ts:274-277`). The base had a two-line inner join.
6. `src/execution/messages.ts:3` imports `nowMicros` from `src/store/database.ts`, the store's internal helper file. The fixtures import `queueHead` and `decodeQueued` from store internals to peek at the queue.
7. `Inserted` (`src/store/model.ts:57-60`) is no longer the declared return of `insertMessage`. Only `history.ts` names it.
8. `Effect.fn` calls each pipeable with the call's arguments as well. That is harmless with `sql.withTransaction` and `unyielding`, which take one. A dual function in that position would misread them.
9. `recoverLost` and `recoverThread` use `Effect.gen` with `withSpan`, where the other 25 methods use `Effect.fn`. The report explains why.
10. Every store call now opens a span and captures a two-frame stack. I measured no cost on an empty thread.
11. `json.ts` is the base text byte for byte, apart from `maxJsonDepth` losing its `export`.
12. The test driver's `forceRecover` now fails with `ThreadNotFound` for a thread that does not exist, where it returned nothing. Test harness only.
13. `recoverLost` returns ids in table order with no `ORDER BY`, before and after.
14. An admission from inside a flow skips recovery (`src/execution/ThreadSupervisor.ts:232`), as before. Removing the condition either way passes all tests.
15. In tests, `acquireHolder` is released by the test's scope after the layer has closed its connection, so that delete fails and is ignored. Reasoned, not observed.
16. I did not review `store-probe.ts` or `queue-probe.ts` beyond their imports, and I did not rerun the implementer's six process cuts or the two recovery races. I ran the full suite once on Node and once on Bun at the head: 505 of 505 on both.

## Files

All under `/tmp/structure/review-3/`.

- `scratch-base/`, `scratch-head/`: installed copies of the two commits. The witness tests are in each under `packages/runtime/test/review3-*.test.ts`.
- `diff-ops.ts`, `diff-base.test.ts`, `diff-head.test.ts`, `diff/`, `diff-compare.mjs`, `diff-stats.mjs`: the seeded replay.
- `witness-shared.test.ts`, `witness-base.test.ts`, `witness-head.test.ts`, `witness-filter.test.ts`, `witness-atomic.test.ts`, and the `witness-*.json` they write.
- `exp1-validators.ts`, `exp1-node.log`, `exp1-bun.log`, `exp2-cause.ts`: the validator comparison.
- `mutate.mjs`, `mutants/`, `mutants-summary.txt`: the mutation runs. `mutate-witness.mjs`, `mutants-witness/`: the same breaks against the witness tests only.
- `bench-assemble.ts`, `bench-node.log`, `bench-bun.log`, `step-probe.log`, `step-probe2.log`: the timings.
- `tsgo-head.log`, `head-node.log`, `head-bun.log`: the checker and the suite.
