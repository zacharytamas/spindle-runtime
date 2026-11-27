# Code quality review: PR 4 (`m1/3-store`, SQLite store)

Reviewed at `origin/m1/7-chat` (`43a4d5b`), traced back to PR 4 (`75dab32..8aaf3ef`). All line numbers refer to `origin/m1/7-chat`.

## 1. Verdict

This would **not pass** the approval bar as it stands at the top of the stack. PR 4's own original store (`ThreadStore.ts` 128 lines, `sqlite.ts` 277 lines) was clean and tightly scoped, but because it exposed a single flat service for every persistence concern, PRs 7, 8, and 10 bolted revision tracking, execution claims, queue delivery, holder tracking, and chat cursors onto the same interface and file. The single largest thing wrong is that `ThreadStore` is now a 28-method god-service backed by a 654-line `sqlite.ts` monolith where four cross-cutting hacks—five incompatible spellings of write-ownership fencing, an exported module-level `WeakMap` for call-result pairing, a three-mode `recover(threadId?, force?)` method, and a dead unfenced `appendMessages` API—leak store internals into `execution/` and `cli/`.

---

## 2. Structural findings

### S1. `ThreadStore` is one 28-method service and 654-line implementation covering three distinct persistence domains

- **Location:** `packages/runtime/src/store/ThreadStore.ts:190-277`, `packages/runtime/src/store/sqlite.ts:103-654`
- **Why it costs maintainers:** Every caller (`history.ts`, `messages.ts`, `ThreadSupervisor.ts`, `cli/status.ts`, `cli/chat.ts`) depends on all 28 methods, tests must stub or wrap the entire interface to spy on one method (`packages/runtime/test/execution/history.test.ts:25-35, 315-320`), and `sqlite.ts` has already grown from 277 to 654 lines in M1 before M2–M4 add handlers, nested prompts, scheduled effects, files, and subagents.
- **Proposed restructuring:** Split the store into three cohesive Effect services backed by one shared `SqlClient` and a `packages/runtime/src/store/sqlite/` folder (`common.ts`, `threads.ts`, `messages.ts`, `runs.ts`, `index.ts`):
  - `ThreadStore` (threads + thread-scoped KV, 5 methods): `createThread`, `getThread`, `terminate`, `getValue`, `setValue`. (Keeping 2 KV methods on `ThreadStore` avoids creating a 2-method micro-service; split out `ThreadKv` only if M3 adds user/global KV.)
  - `MessageStore` (history, CRUD, cursor, 9 methods): `insertMessage`, `getMessage`, `getMessages`, `updateMessage`, `deleteMessage`, `revision`, `history`, `messageIdTaken`, `messagesAfter` (dropping `appendMessages` and folding `latestMessageSeq` into thread/open snapshot or keeping it here).
  - `RunStore` (claims, queue, holders, recovery, 11 methods): `admit`, `claim`, `isQueued`, `nextQueued`, `queueLength`, `settle`, `recoverLost`, `recoverThread`, `forceRecover`, `acquireHolder`, `holderOf`, `owned`.
  - Keep `transaction` on a tiny `StoreTransaction` helper or directly on `ThreadStore` (since `docs/design/thread-ownership.md:35` keeps it for tests), or expose one composed `storeLayer: Layer.Layer<ThreadStore | MessageStore | RunStore, SqlError | MigrationError, SqlClient>` built with `Layer.mergeAll` after running pragmas and migrations once in `sqlite/index.ts`.
  - Cross-domain atomic operations (`terminate` settling an active flow, `insertMessage` dequeuing a pending entry) stay single SQLite transactions by sharing `SqlClient` and internal helpers (`guardThread`, `closeCalls`, `selectRun`) in `sqlite/common.ts`.

  ```ts
  // packages/runtime/src/store/sqlite/index.ts
  const initialized = Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`PRAGMA foreign_keys = ON`
      yield* sql`PRAGMA synchronous = FULL`
      yield* migrate
    }),
  )
  export const layer = Layer.mergeAll(threadLayer, messageLayer, runLayer).pipe(Layer.provide(initialized))
  ```
- **Estimated line delta:** Roughly neutral on total lines (~+20 lines for service declarations and layer wiring), but replaces a 654-line file with four ~120–180-line modules and cuts the dependency surface of `history.ts`, `messages.ts`, `ThreadSupervisor.ts`, and `cli/status.ts` by 60–90%.
- **Risk and guarding tests:** Low behavioral risk because all three services share the exact same `SqlClient` connection and transaction scope. Guarded by `packages/runtime/test/store/contract.test.ts`, `packages/runtime/test/store/claims.test.ts`, `packages/runtime/test/store/unfenced.test.ts` (update to check `RunStore`), `packages/runtime/test/execution/history.test.ts`, and `packages/runtime/test/spindle-driver.ts`.
- **Target PR and ripple:** Split `ThreadStore` + `MessageStore` and create `store/sqlite/` in **PR 4** (`m1/3-store`); introduce `RunStore` in **PR 8** (`m1/6-queue`) where claims/queue/holders are added. Ripples through PRs 6, 7, 8, and 10 at every `yield* ThreadStore` call site (mechanical import/service swap).
- **Effect API verification:** Verified `Context.Service` (`node_modules/effect/dist/Context.d.ts:196`), `Layer.mergeAll` (`node_modules/effect/dist/Layer.d.ts:1434`), `Layer.effect` (`Layer.d.ts:1166`), and shared `SqlClient` (`node_modules/effect/dist/sql/SqlClient.d.ts:189`).

---

### S2. Write-ownership fencing is spelled five different ways and leaks an ambient `Context.Reference` across fiber boundaries

- **Location:** `packages/runtime/src/store/ThreadStore.ts:158-168`, `packages/runtime/src/store/sqlite.ts:117-143, 254-260, 275-277, 303-314, 422, 450, 495-505, 515-517, 556, 573-574`, `packages/runtime/src/execution/ThreadSupervisor.ts:152, 229`, `packages/runtime/src/execution/thread-state.ts:192-196`
- **Why it costs maintainers:** Confirming and expanding the audit note: checking whether a writer still owns a thread is implemented five ways—(1) `guardWrite` reading `WritingHandle` (`updateMessage`, `deleteMessage`, `setValue`), (2) `checkHandle` called inline after `selectRun` (`admit`, `terminate`), (3) `insertMessage` duplicating the `FlowEnded` check for `options.flowId` AND then calling `checkHandle(..., true)` with a magic boolean `injection = true` (checking `flow_id` twice whenever a tool/hook injects!), (4) `settle` returning `"superseded"` on `row.flow_id !== flowId`, and (5) `nextQueued` inlining `AND EXISTS (SELECT 1 FROM threads WHERE id = ${threadId} AND flow_id = ${flowId})` in SQL. Worse, because `WritingHandle` is a fiber-inherited `Context.Reference` whose default is `undefined` (unrestricted external authority), `ThreadSupervisor.ts:152` must defensively wipe it to `undefined` when forking a new execution, and `ThreadSupervisor.ts:229` peeks into `WritingHandle` to guess whether `admit` came from inside a flow.
- **Proposed restructuring:** Replace the dual `WritingHandle` + `options.flowId` mechanism with one explicit `WriteOrigin` value (or one `guardThread` helper inside `sqlite/common.ts` if `WritingHandle` is kept for `ThreadState` ergonomics):
  ```ts
  export type WriteOrigin =
    | { readonly kind: "external"; readonly terminated?: number | null }
    | { readonly kind: "flow"; readonly flowId: string }
    | { readonly kind: "handle"; readonly owner: HandleOwner }

  // One helper in sqlite/common.ts used by every thread-mutating SQLite operation:
  const authorize = (
    threadId: string,
    row: { readonly flow_id: string | null; readonly terminated_at: number | null },
    origin: WriteOrigin,
    options?: { readonly allowPostTerminationInjection?: boolean },
  ): Effect.Effect<void, WriteRefused> => ...
  ```
  - Every mutator (`insertMessage`, `updateMessage`, `deleteMessage`, `setValue`, `admit`, `terminate`) runs `authorize` on the single `threads` row it already selects inside its transaction.
  - `ThreadSupervisor.ts:152` (`Effect.provideService(WritingHandle, undefined)`) and `ThreadSupervisor.ts:229` (`if ((yield* WritingHandle)?.flowId === undefined)`) disappear because `admit` knows its origin explicitly (external send vs `ThreadControl` from a handle).
  - `insertMessage` drops its duplicated `FlowEnded` branch (`sqlite.ts:307-312`), the dead runtime `if (dequeue !== undefined && flowId === undefined)` defect (`sqlite.ts:305-306`, already impossible in the `InsertOptions` type), and the boolean `injection = true` flag.
  - `terminate` keeps the documented behavior (`docs/plans/m1-core-loop.md:890`) of returning `existing.terminated_at` early on an already-terminated thread before `authorize`.
- **Estimated line delta:** Removes ~45 lines across `sqlite.ts`, `ThreadStore.ts`, `ThreadSupervisor.ts`, and `thread-state.ts`, and eliminates the ambient fiber-inheritance hazard.
- **Risk and guarding tests:** High-value invariant (stale handles/flows must never commit after expiry, abort, termination, or takeover). Guarded by `packages/runtime/test/store/claims.test.ts:304-385`, `packages/conformance/src/scenarios/queue.ts`, and `packages/runtime/test/cli/queue.test.ts`. Note: `makeThreadState` (`thread-state.ts:192`) would pass `origin` into `WriteContext`, `ThreadControl`, and direct `store.*` calls instead of `Context.add(..., WritingHandle, ...)`.
- **Target PR and ripple:** **PR 8** (`m1/6-queue`), which introduced `WritingHandle`, `checkHandle`, and `guardWrite`. Ripples into PR 10 (`m1/7-chat`, `cli/chat.ts` external calls only).
- **Effect API verification:** Verified `Context.Reference` (`node_modules/effect/dist/Context.d.ts:1741`) — removing the ambient `Context.Reference` eliminates the fiber-inheritance leak by construction.

---

### S3. Call-result pairing rides on a module-level `WeakMap` exported from `ThreadStore.ts` and a throwing `callerSequence` helper

- **Location:** `packages/runtime/src/store/ThreadStore.ts:175-185`, `packages/runtime/src/store/schema.ts:150-151`, `packages/runtime/src/store/sqlite.ts:334-341`, `packages/runtime/src/execution/history.ts:48-49`, `packages/runtime/src/execution/step.ts:486, 625-631`, `packages/runtime/src/execution/assemble.ts:189, 248, 269`
- **Why it costs maintainers:** Confirming the audit note: `ThreadStore.ts` exports a mutable global `WeakMap<Message, MessagePosition>()` and `callerSequence(caller)` which throws a raw `new Error("Stored caller has no sequence")`. To keep this hidden side-channel alive, `toMessage` mutates global state on decode, `insertMessage` branches between two `INSERT` statements (`RETURNING seq` vs plain `INSERT`), `history.ts` must manually copy WeakMap entries when cloning messages, `step.ts:625-631` has to rebuild WeakMap entries by `message.id` after `filter_messages` clones the array, and `toProviderMessages` in `assemble.ts` is silently impure because its output depends on global WeakMap state.
- **Proposed restructuring:** Return the storage position explicitly on the internal wrapper types that already exist, and delete `positions` and `callerSequence`:
  1. Add `readonly seq: number` (and `readonly callerSeq: number | null`) to `Inserted` (`ThreadStore.ts:65-68`). `insertMessage` always executes `INSERT INTO messages ... RETURNING seq`, deleting the `if (row.tool_calls !== null || facts.caller_seq !== null)` branch (`sqlite.ts:334-338`). `createMessage` (or an internal `createStoredMessage` for `step.ts`) returns `seq` alongside `message`, so `step.ts:486` passes `callerSeq: caller.seq` directly with zero throws.
  2. Add `readonly positions: ReadonlyMap<string, MessagePosition>` (keyed by globally unique `message.id`) to `ThreadHistory` (`ThreadStore.ts:71-74`), populated purely by `history(threadId)` from the selected rows.
  3. `history.ts` caches `{ revision, messages, positions }` and adds `inserted.seq` / `inserted.callerSeq` under `inserted.message.id` in `inserted()`.
  4. `toProviderMessages(filtered, view, positions)` (`assemble.ts:234`) takes `positions?: ReadonlyMap<string, MessagePosition>` explicitly and looks up `positions?.get(message.id)`. Because `message.id` survives `structuredClone` inside `filter_messages`, the entire re-hydration loop in `step.ts:625-631` and WeakMap copying in `history.ts:48-49` disappear completely, and `toMessage` becomes pure.
  (Checked: `step.ts:626` already maps positions by `message.id`, so keying by `message.id` is 100% behaviorally identical even when hooks clone or duplicate messages.)
- **Estimated line delta:** Removes ~35 lines across 6 files and deletes all global mutable pairing state.
- **Risk and guarding tests:** Very low risk; `messages.id` is `UNIQUE` (`0001_threads.ts:23`), and `claims.test.ts:57` simply changes `callerSequence(inserted.message)` to `inserted.seq`. Guarded by `packages/runtime/test/store/claims.test.ts`, `packages/runtime/test/execution/history.test.ts`, and `packages/conformance/src/scenarios/integrity.ts` / `queue.ts`.
- **Target PR and ripple:** **PR 8** (`m1/6-queue`), which introduced `positions` and `callerSequence`. No changes needed in PR 10 beyond rebasing `sqlite.ts` and `step.ts`.
- **Effect API verification:** Pure TypeScript/Effect data flow; no new Effect APIs required.

---

### S4. `recover(threadId?, force?)` packs three callers into one signature and runs three queries on `threads` per recovery

- **Location:** `packages/runtime/src/store/ThreadStore.ts:260-262`, `packages/runtime/src/store/sqlite.ts:596-619`, `packages/runtime/src/cli/status.ts:58-76`, `packages/runtime/src/execution/ThreadSupervisor.ts:131, 229, 282`, `packages/runtime/src/cli/chat.ts:121`
- **Why it costs maintainers:** Confirming the audit note: one optional parameter and one boolean flag serve three distinct operations—background sweep (`recover()`), single-thread dead-holder check (`recover(id)`, whose `string[]` return every caller ignores), and forced operator takeover (`recover(id, true)`). Nothing in the type forbids `recover(undefined, true)`, which would force-kill every live execution in the database. Because `recover` only returns `ReadonlyArray<string>`, `cli/status.ts:58-76` has to open a manual `store.transaction`, pre-read `getThread` and `holderOf`, and then call `store.recover(thread, force)`—which itself runs `candidates` twice (outside and inside a nested savepoint!) and then calls `selectRun(row.id)` a third time inside the loop (`sqlite.ts:613`) even though `candidates` already queried `threads`.
- **Proposed restructuring:** Split into three explicit methods sharing one internal `settleLost` helper, and project `runColumns` directly in `candidates` so the third query per row disappears:
  ```ts
  export type RecoverOutcome =
    | { readonly kind: "not_running"; readonly status: ThreadStatus }
    | { readonly kind: "alive"; readonly holder: Holder }
    | { readonly kind: "recovered"; readonly holder: Holder | null; readonly forced: boolean }

  // On RunStore / ThreadStore:
  readonly recoverLost: () => Effect.Effect<ReadonlyArray<string>, SqlError>
  readonly recoverThread: (threadId: string) => Effect.Effect<boolean, SqlError>
  readonly forceRecover: (threadId: string) => Effect.Effect<RecoverOutcome, ThreadNotFound | SqlError>
  ```
  Or let `recoverThread(threadId, { force?: boolean }): Effect<RecoverOutcome, ThreadNotFound | SqlError>` serve single-thread recovery (making `recover(undefined, true)` unrepresentable) while `recoverLost()` serves the supervisor sweep (`ThreadSupervisor.ts:282`). Then `cli/status.ts:58-76` drops its manual `store.transaction`, `getThread`, and `holderOf` calls and pattern-matches `RecoverOutcome` directly. Inside `sqlite.ts`, `candidates` selects `t.id, t.holder_id, h.pid, ${runColumns}` once, eliminating `selectRun(row.id)` (`sqlite.ts:613`), and checks `processAlive` with `Effect.filter(..., { concurrency: "unbounded" })` instead of a sequential `for` loop.
- **Estimated line delta:** Removes ~25 lines across `sqlite.ts` and `cli/status.ts`, and eliminates 1–2 redundant SQL queries per recovery call.
- **Risk and guarding tests:** Low risk. Note that `recoverThread` called from `statusOf` / `admit` / `statusCommand` on a nonexistent thread should either return `"not_running"` / `false` (preserving `statusCommand`'s own `ThreadNotFound` error message) or let callers catch `ThreadNotFound`. Guarded by `packages/runtime/test/store/claims.test.ts:73-94, 261-302`, `packages/runtime/test/cli/queue.test.ts:192`, and `packages/runtime/test/spindle-driver.ts:173`.
- **Target PR and ripple:** **PR 8** (`m1/6-queue`), which introduced `recover`. Ripples to `cli/chat.ts:121` in PR 10.
- **Effect API verification:** Verified `Effect.filter` concurrency option in `node_modules/effect/dist/Effect.d.ts` (note: `processAlive` in `platform/process-alive.ts` is synchronous `Effect.sync`, so even sequential is cheap, and `candidates` projecting `runColumns` is pure SQL).

---

### S5. `appendMessages` is dead in production and unfenced; `nextQueued`'s optional `flowId?` hides a mutating quarantine mode

- **Location:** `packages/runtime/src/store/ThreadStore.ts:197-200, 251`, `packages/runtime/src/store/sqlite.ts:272-291, 545-560`
- **Why it costs maintainers:**
  1. `appendMessages` has **zero callers in `packages/runtime/src/`**—only tests (`contract.test.ts`, `claims.test.ts`, `hooks.test.ts`, `history.test.ts`, `spindle-driver.ts`) and probes (`store-probe.ts`, `step-probe.ts`) call it. PR 7 replaced production inserts with `insertMessage`, and PR 8 deleted `enqueue`, `takeQueue`, and `setStatus` (`unfenced.test.ts:13`), but left `appendMessages` behind. It bypasses `WritingHandle` and `flowId`, omits `RETURNING seq` (so returned messages have no `positions` entry), and duplicates message-row serialization (`sqlite.ts:281-287` vs `323-327`).
  2. `nextQueued(threadId, flowId?)` uses an optional `flowId` as a hidden mode switch: with `flowId` (`step.ts:565`), a corrupt row is updated to `disposition = 'failed_delivery'` and skipped in a `while (true)` loop; without `flowId` (only `store-fixtures.ts:11` and `claims.test.ts:107`), it silently returns `undefined` on a corrupt row instead of failing or quarantining.
- **Proposed restructuring:**
  1. Remove `appendMessages` from `ThreadStore` (or, if batch seeding stays needed for tests/probes, put a 10-line `appendMessages` helper in `packages/runtime/scripts/store-fixtures.ts` built on `store.transaction` + `store.insertMessage`—preserving atomic all-or-none rollback behavior tested by `contract.test.ts:445`).
  2. Make `flowId: string` required on `nextQueued(threadId, flowId)` (and update `store-fixtures.ts:11` and `claims.test.ts:107` to pass the test's `flowId`).
- **Estimated line delta:** Removes ~25 lines from `ThreadStore.ts` and `sqlite.ts`; adds ~10 lines in `scripts/store-fixtures.ts` if kept for fixtures.
- **Risk and guarding tests:** `contract.test.ts` has ~25 tests calling `store.appendMessages` (originally written in PR 4 before `insertMessage` existed). Moving `appendMessages` to a fixture helper over `insertMessage` keeps all those tests green while shrinking the production store surface and closing an unfenced write path. (`contract.test.ts:445` tests transaction atomicity; `contract.test.ts:204` tests microsecond timestamps—both still pass through `store.transaction` + `nowMicros`.)
- **Target PR and ripple:** Removing `appendMessages` belongs in **PR 8** (`m1/6-queue`, alongside the removal of `takeQueue`/`setStatus`/`enqueue` in `unfenced.test.ts`), or PR 7 (`m1/5-hooks`) once `insertMessage` lands; making `nextQueued`'s `flowId` required belongs in **PR 8**.
- **Effect API verification:** No new Effect APIs required.

---

### S6. `schema.ts` hand-rolls row decoding, `AttachmentRef` checks, and throwing `toQueued` where Effect `Schema` removes code—while `toJson` must stay

- **Location:** `packages/runtime/src/store/schema.ts:5-244`, `packages/runtime/src/store/sqlite.ts:389-394, 433-438, 551-558`
- **Why it costs maintainers:** Answering the prompt directly: `schema.ts` is 332 lines split across two very different jobs.
  1. **Row/queue/attachment decoding (lines 5–244) SHOULD use Effect `Schema`.** Right now `schema.ts` manually duplicates TypeScript row interfaces (`ThreadRow`, `MessageRow`, `QueueRow`), calls unchecked `JSON.parse` (`schema.ts:66, 139, 147, 188, 238`), repeats `text(...)` 10 times and `stored(...)` 10 times, hand-codes `row.silent === 1` / `message.silent === true ? 1 : 0`, re-implements `isCount`, `isAttachmentRef`, and `isQueueMessage` with manual `typeof` chains (18 lines), and throws `new Error("Invalid queued payload")` in `toQueued` (`schema.ts:243`), which directly causes the `try`/`catch` inside `Effect.gen` at `sqlite.ts:551`.
  2. **Strict user-value serialization (`toJson`, lines 246–332) MUST NOT be replaced with `Schema.fromJsonString`.** `contract.test.ts:1027-1158` requires single-pass read-and-serialize (so a mutating getter cannot pass validation and write different data), cross-realm plain-object prototype checking, rejection of any own/inherited `toJSON` method, catching throwing getters, a 1000-level nesting cap, and structured `ValueNotJson({ field, path, found })` errors. Standard `Schema.fromJsonString` delegates to `JSON.stringify` and violates all of those guarantees. Keep `toJson` (optionally in its own `store/json.ts` since `execution/hooks.ts:11` and `execution/thread-state.ts:11` import it too).
- **Proposed restructuring:** Move lines 5–244 to Effect 4.1.5 `Schema` primitives:
  ```ts
  const SqliteText = Schema.Union([Schema.String, Schema.Uint8Array]).pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transform({
        decode: (value) => (value instanceof Uint8Array ? utf8.decode(value) : value),
        encode: (value) => value.replace(loneSurrogates, "\ufffd"),
      }),
    ),
  )

  export const AttachmentRefSchema = Schema.Struct({
    type: Schema.Literal("file"),
    id: Schema.String,
    path: Schema.String,
    name: Schema.String,
    mimeType: Schema.String,
    size: Schema.Natural,
    width: Schema.optional(Schema.Natural),
    height: Schema.optional(Schema.Natural),
    description: Schema.optional(Schema.String),
  })
  export const isAttachmentRef = Schema.is(AttachmentRefSchema)

  const QueueMessageSchema = Schema.Struct({
    role: Schema.Literals(["user", "assistant"]),
    content: Schema.String,
    silent: Schema.optional(Schema.Boolean),
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    attachments: Schema.optional(Schema.Array(AttachmentRefSchema)),
  })

  const QueueToolSchema = Schema.Struct({
    toolName: Schema.String,
    args: Schema.Record(Schema.String, Schema.Unknown),
  })

  // Replaces throwing toQueued + try/catch in sqlite.ts:551:
  export const decodeQueued = (row: QueueRow): Option.Option<Queued> =>
    row.kind === "message"
      ? Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(QueueMessageSchema))(row.payload), (message) => ({
          seq: row.seq,
          queuedAt: row.queued_at,
          kind: "message" as const,
          message,
        }))
      : Option.map(Schema.decodeUnknownOption(Schema.fromJsonString(QueueToolSchema))(row.payload), ({ toolName, args }) => ({
          seq: row.seq,
          queuedAt: row.queued_at,
          kind: "tool" as const,
          toolName,
          args,
        }))
  ```
  Similarly, `MessageRowSchema` uses `Schema.NullOr(SqliteText)`, `Schema.BooleanFromBit` for `silent`, and `Schema.fromJsonString` for `attachments` and `metadata`, while `getMessages` (`sqlite.ts:389-394`) can use `Schema.is(Schema.Natural)` instead of its duplicate `isCount`.
  Also fix `updateMessage` (`sqlite.ts:433-438`), which currently calls `toJson` **twice** (once on `updates.metadata`, then parses both `current.metadata` and `patch`, spreads them, and runs `toJson` again on the merged object); validating `updates.metadata` once with `toJson` and merging with `JSON.stringify({ ...JSON.parse(current.metadata), ...JSON.parse(patch) })` is enough because both halves are already valid JSON objects.
- **Estimated line delta:** Removes ~50 lines from `schema.ts`, removes the `try/catch` in `sqlite.ts:551`, and removes duplicate `isCount`/`isRecord` definitions.
- **Risk and guarding tests:** Check one subtlety on `toMessage` performance on large histories: `docs/plans/m1-core-loop.md:857` notes `history` only runs on cache miss (first read or external mutation), so `Schema.decodeUnknownSync` on `MessageRow` only runs on cold reads—not per step—but should still be checked against the 5,000-message probe if used for every row of `history`. For `AttachmentRefSchema`, `QueueMessageSchema`, `QueueToolSchema`, and `ThreadRow`, there is zero scaling concern. Guarded by `packages/runtime/test/store/contract.test.ts` (all NUL, BOM, lone-surrogate, JSON, and query-bound tests) and `packages/runtime/test/store/claims.test.ts`.
- **Target PR and ripple:** Core `SqliteText` / row schemas in **PR 4** (`m1/3-store`); `AttachmentRefSchema` + `decodeQueued` in **PR 8** (`m1/6-queue`, where `isAttachmentRef` and `isQueueMessage` were added). Minimal ripple outside `store/` (`isAttachmentRef` keeps the same signature for `ThreadSupervisor.ts` and `hooks.ts`).
- **Effect API verification:** Verified all APIs directly in `node_modules/effect/dist/Schema.d.ts` and `SchemaTransformation.d.ts` AND executed them against Effect 4.1.5 in scratch Node 22:
  - `Schema.Natural` (`Schema.d.ts:6258`) accepts `0` and `MAX_SAFE_INTEGER`, rejects `-1`, `1.5`, `1e20`, `NaN`, `Infinity`.
  - `Schema.BooleanFromBit` (`Schema.d.ts:7876`) decodes `0 | 1` to `boolean` and encodes `boolean` to `0 | 1`.
  - `Schema.Union([Schema.String, Schema.Uint8Array]).pipe(Schema.decodeTo(Schema.String, SchemaTransformation.transform(...)))` (`Schema.d.ts:4726`, `SchemaTransformation.d.ts:401`) preserves leading `U+FEFF` and embedded NUL bytes on decode and normalizes lone surrogates to `\ufffd` on encode.
  - `Schema.fromJsonString` (`Schema.d.ts:7292`), `Schema.decodeUnknownOption` (`Schema.d.ts:1345`), `Schema.is` (`Schema.d.ts:1157`), `Schema.Literals` (`Schema.d.ts:4239`).

---

### S7. Related SQL queries repeat predicates and double-query the same row inside a single transaction

- **Location:** `packages/runtime/src/store/sqlite.ts:112-151, 164-167, 255-268, 317, 424-443, 451-477, 490-510, 531-580`
- **Why it costs maintainers:** Answering the prompt directly: yes, related SQL is repeated extensively, and four methods query the same primary key twice inside one transaction:
  1. **`threads` lookup repeated in 7 projections** (`requireThread:113`, `guardWrite:138`, `selectRun:149`, `getThread:240`, `insertMessage:300`, `revision:349`, `history:359`, plus raw duplicates of `selectRun` in `claim:531` and `settle:573`).
  2. **Double-queries inside one `BEGIN IMMEDIATE` transaction:**
     - `setValue` (`sqlite.ts:492-509`) duplicates the entire `sql.withTransaction` block for delete vs upsert, and in both branches calls `requireThread(threadId)` (`SELECT id FROM threads`) immediately followed by `guardWrite(threadId)` (`SELECT flow_id, terminated_at FROM threads`).
     - `terminate` (`sqlite.ts:255-268`) calls `selectRun(threadId)` (`existing`), runs `UPDATE threads SET terminated_at = coalesce(terminated_at, ${now}) ... RETURNING terminated_at`, and then calls `selectRun(threadId)` a second time (`run`) even though `existing` was already fetched inside the same write transaction and `run_state`/`flow_id` did not change.
     - `updateMessage` (`sqlite.ts:424-443`) runs `selectMessages(where)`, updates without `RETURNING`, and runs `selectMessages(where)` a second time—even when `Object.keys(changes).length === 0`!
  3. **Pending-queue predicate repeated 6 times:** `WHERE disposition = 'pending' AND thread_id = ${threadId}` is spelled out in `insertMessage:317`, `claim:534`, `isQueued:541`, `nextQueued:549`, `queueLength:566`, and `settle:579` (`claim:534` and `settle:579` are byte-for-byte identical).
  4. **Inconsistent NUL-safe column reads:** `schema.ts:101` wraps `tool_calls` with `textColumn("tool_calls")`, but `closeCalls` (`sqlite.ts:165`) and `deleteMessage` (`sqlite.ts:452`) select raw `tool_calls` and raw `CAST(parent_id AS BLOB)` instead of using `textColumn`.
  5. **Thread-length scaling note (`brief.md:53`):** In `deleteMessage` (`sqlite.ts:465-476`), the legacy cascade for unlinked rows (`caller_seq IS NULL AND flow_id IS NULL`) runs a correlated `NOT EXISTS` with `json_each` over every later call-bearing row in the thread—O(N²) in the number of legacy tool-call messages after `parent.seq`. (Runtime-inserted messages set `caller_seq` and hit the indexed `DELETE FROM messages WHERE caller_seq = ${parent.seq}` on line 464, so this only affects unlinked seeded rows, but it still scans all later rows on every call-bearing delete because there is no partial index on `(thread_id, seq) WHERE caller_seq IS NULL AND flow_id IS NULL AND role = 'tool'`.)
- **Proposed restructuring:**
  - Collapse `setValue` into one `sql.withTransaction` using the unified `guardThread(threadId)` (1 query instead of 2).
  - In `terminate`, reuse `existing` instead of re-querying `selectRun(threadId)`, and drop `coalesce` since line 256 already returned when `existing.terminated_at !== null`.
  - In `updateMessage`, return `toMessage(current)` immediately when `changes` is empty, otherwise `UPDATE messages SET ${sql.update(changes)} WHERE ${where} RETURNING ${sql.literal(messageColumns)}`.
  - Extract `hasPendingQueue(threadId)` (used by `claim` and `settle`) and a `pendingWhere(threadId, extra?)` fragment helper.
  - Export `textColumn` from `schema.ts` so `closeCalls` and `deleteMessage` use the exact same NUL-safe projection.
- **Estimated line delta:** Removes ~35 lines from `sqlite.ts`.
- **Risk and guarding tests:** Low risk; pure query consolidation inside existing transactions. Guarded by `contract.test.ts` (update, delete, KV, NUL tests) and `claims.test.ts` (terminate, claim, settle).
- **Target PR and ripple:** `updateMessage` `RETURNING` and `setValue` single-branch cleanup belong in **PR 4** (`m1/3-store`); `terminate`, `hasPendingQueue`, `closeCalls`, and `guardThread` consolidation belong in **PR 8** (`m1/6-queue`). No external ripple.
- **Effect API verification:** Verified `sql.and`, `sql.update`, `sql.literal` in `node_modules/effect/dist/sql/Statement.d.ts`.

---

### S8. `localHolders` is a process-wide mutable `Set` that leaks across independent databases and tests

- **Location:** `packages/runtime/src/store/sqlite.ts:48-49, 602, 625, 633`, `packages/runtime/src/store/ThreadStore.ts:263-264`
- **Why it costs maintainers:** `const localHolders = new Set<string>()` lives at module top level outside Effect's service/scope system. Entries are only removed if a caller remembers to call `dropHolder(id)`. In `packages/runtime/test/store/claims.test.ts:267`, a test calls `store.registerHolder({ id: "alive", pid: processId })` on an in-memory DB and never drops it, permanently polluting `localHolders` for every later test in the same worker process.
- **Proposed restructuring:** Replace the `registerHolder`/`dropHolder` pair with a scoped `acquireHolder(holder: Holder): Effect.Effect<void, SqlError, Scope.Scope>` built on `Effect.acquireRelease` (matching how `ThreadSupervisor.ts:302-310` already registers on layer start and drops in a finalizer), and hold the active-holder set in a `Context.Reference` (or `Ref<ReadonlySet<string>>` / process-scoped registry keyed per database or cleaned by the release finalizer) so closing a scope or test always removes its holder ID from both SQLite and memory.
- **Estimated line delta:** Roughly neutral (~-5 lines across `sqlite.ts` and `ThreadSupervisor.ts`).
- **Risk and guarding tests:** Low risk; `claims.test.ts:266-267, 391-396` tests holder registration and dropping and can run inside `Effect.scoped` (or keep a test helper). Remember the invariant from `sqlite.ts:48`: two separate connections in the same process to the *same* database file must both see holders registered by this process's supervisors—so the default value of a `Context.Reference` backed by a `Ref` (with `acquireRelease` deleting on scope close) preserves cross-connection visibility while guaranteeing cleanup!
- **Target PR and ripple:** **PR 8** (`m1/6-queue`), which introduced `localHolders` and `registerHolder`/`dropHolder`. Ripples to `ThreadSupervisor.ts:302-310` and `claims.test.ts`.
- **Effect API verification:** Verified `Effect.acquireRelease` and `Scope.Scope` in `node_modules/effect/dist/Effect.d.ts` and `Scope.d.ts`.

---

## 3. Effect practice findings

Running `@effect/tsgo@0.73.7` in a scratch checkout at `origin/m1/7-chat` (`43a4d5b`) produced **2 default diagnostics** in `packages/runtime/src/store/` (confirmed in `/tmp/quality-review/effect-diagnostics-at-tip.txt:19-20`) plus actionable opt-in diagnostics when additional rules from `node_modules/@effect/tsgo/schema.json` were switched on.

### E1. Confirmed `effect(tryCatchInEffectGen)` (default rule, TS377012) — `nextQueued` catches thrown `Error` from `toQueued`

- **Location:** `packages/runtime/src/store/sqlite.ts:551-558`, `packages/runtime/src/store/schema.ts:237-244`
- **Why it costs maintainers:** `toQueued` uses unchecked `JSON.parse` and throws a raw `new Error("Invalid queued payload")`, forcing `nextQueued` into a `try { return toQueued(row) } catch { ... }` inside `Effect.gen`. Any unexpected bug inside `toQueued` is silently swallowed and misclassified as a corrupt queue row (`failed_delivery`).
- **Proposed restructuring:** Replace `toQueued` with `decodeQueued` returning `Option.Option<Queued>` (via `Schema.decodeUnknownOption(Schema.fromJsonString(...))`, see S6) and branch on `Option.isSome(decoded)`.
- **Estimated line delta:** -6 lines.
- **Risk and guarding tests:** Low risk; guarded by `claims.test.ts` and `packages/conformance/src/scenarios/queue.ts` (corrupt queue entry quarantine).
- **Target PR and ripple:** **PR 8** (`m1/6-queue`). Local to `schema.ts` and `sqlite.ts`.
- **Effect API verification:** Verified `Schema.decodeUnknownOption` (`node_modules/effect/dist/Schema.d.ts:1345`) and `Option.isSome` (`Option.d.ts`).

---

### E2. Confirmed `effect(flatMapMapToZipWith)` (default rule, TS377218) — `history` nests `Effect.flatMap` + `Effect.map` for an independent service read

- **Location:** `packages/runtime/src/store/sqlite.ts:364-371` (compare `sqlite.ts:295`)
- **Why it costs maintainers:** `history` wraps its deferred read transaction in `Effect.flatMap(Effect.serviceOption(sql.transactionService), (outer) => Effect.map(read, ...))`, which triggers TS377218 and spells the nested-transaction check differently from `insertMessage` (`sqlite.ts:295`), which uses `Effect.gen`.
- **Proposed restructuring:** Use `Effect.zipWith(Effect.serviceOption(sql.transactionService), read, (outer, history): ThreadHistory => (Option.isSome(outer) ? { ...history, revision: null } : history))`, or extract one `withCommittedRevision` helper shared by `history` and `insertMessage`.
- **Estimated line delta:** -4 lines.
- **Risk and guarding tests:** Zero behavioral change. Guarded by `contract.test.ts:335-374` and `packages/runtime/test/execution/history.test.ts`.
- **Target PR and ripple:** **PR 7** (`m1/5-hooks`), which introduced `history` and `revision`. Local to `sqlite.ts`.
- **Effect API verification:** Verified `Effect.zipWith` (`node_modules/effect/dist/Effect.d.ts:4288`).

---

### E3. Confirmed `effect(anyUnknownInErrorContext)` (opt-in rule, TS377030) — `unyielding` erases service types with `Object.fromEntries(... as S)`

- **Location:** `packages/runtime/src/store/sqlite.ts:70-83`
- **Why it costs maintainers:** `unyielding` reflects over the store object with `Object.entries`/`Object.fromEntries`, calls `member(...args)` as untyped `any`/`unknown` (causing TS377030 at line 79: `unknown` in requirements and error channels), and casts the result `as S`. Any non-Effect helper added to the service would silently break at runtime, and every store call pays an extra `Effect.service` + `Effect.flatMap` wrapper.
- **Proposed restructuring:** Keep the `Scheduler.PreventSchedulerYield` invariant (it is essential for synchronous `queueTool` and proved by `claims.test.ts:400`), but express it as a typed combinator `const nonYielding = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>` used inside `sqlite/common.ts`'s `tx`/`readTx`/single-query helpers, or constrain `unyielding`'s mapped type to `Record<string, (...args: ReadonlyArray<never>) => Effect.Effect<unknown, unknown, unknown>>` without erasing `E`/`R` via `unknown`.
- **Estimated line delta:** ~0 lines (replaces 14-line untyped reflection with a 6-line typed combinator).
- **Risk and guarding tests:** Medium risk if any store method is missed—must remain guarded by `packages/runtime/test/store/claims.test.ts:400-429` (`MaxOpsBeforeYield = 1` stress test).
- **Target PR and ripple:** **PR 8** (`m1/6-queue`), which introduced `unyielding`. Local to `sqlite.ts`.
- **Effect API verification:** Verified `Scheduler.PreventSchedulerYield` in `node_modules/effect/dist/Scheduler.d.ts`.

---

### E4. Confirmed `effect(globalJson)` & `effect(globalJsonInEffect)` (opt-in rules, TS377156/TS377157) — unchecked `JSON.parse` on database columns

- **Location:** `packages/runtime/src/store/schema.ts:66, 139, 147, 188, 238`, `packages/runtime/src/store/sqlite.ts:436, 486` (Note: `schema.ts:277, 281, 316` inside `toJson` and `ThreadStore.ts:78, 103` / `sqlite.ts:502` formatting error strings are benign primitive-string quoting and should be ignored.)
- **Why it costs maintainers:** Raw `JSON.parse` on `threads.arguments`, `messages.attachments`, `messages.metadata`, and `kv.value` throws untyped `SyntaxError` defects outside Effect's error model and performs zero shape validation on decoded rows.
- **Proposed restructuring:** Decode `ThreadRow`, `MessageRow`, and `QueueRow` through `Schema.fromJsonString` (see S6), and use `SqlSchema.findOneOption` / `SqlSchema.findAll` from `effect/sql/SqlSchema` for typed row queries where no custom column expression prevents it, mapping `SchemaError` explicitly (either into a store corruption defect via `Effect.orDie` or `Option` for `decodeQueued`).
- **Estimated line delta:** Covered by S6 (-50 lines overall).
- **Risk and guarding tests:** Low risk; guarded by `contract.test.ts` and `claims.test.ts`.
- **Target PR and ripple:** **PR 4** (`m1/3-store`), with `queue.payload` updated in **PR 8**.
- **Effect API verification:** Verified `SqlSchema` (`node_modules/effect/dist/sql/SqlSchema.d.ts:34-100`) and `Schema.fromJsonString` (`Schema.d.ts:7292`).

---

### E5. `scripts/store-probe.ts` (626 lines) bypasses Effect platform/CLI/process APIs entirely

- **Location:** `packages/runtime/scripts/store-probe.ts:1-140, 188-626`
- **Confirmed `effect-tsgo` opt-in diagnostics:** `asyncFunction` (21), `nodeBuiltinImport` (3: `node:child_process`, `node:fs`, `node:path`), `newPromise` (3: lines 100, 116, 138), `globalConsole` (4), `globalTimers` (2: `setInterval` line 132, `setTimeout` line 138), `globalRandom` (1: line 317).
- **Why it costs maintainers:** `store-probe.ts` hand-rolls 130 lines of Node `spawn` stdout buffering, `waitForLine` promise queues, manual `process.argv.indexOf` flag parsing, `setTimeout` sleep, and `Effect.runPromise` inside every subcommand—even though the runtime already has `effect/cli`, `effect/process` (`ChildProcess` / `ChildProcessSpawner`, already used by `contract.test.ts:1163`), `Effect.sleep`, `FileSystem`, and `PlatformLive`. It also hardcodes a module-level `const claim = { holder: crypto.randomUUID(), flowId: crypto.randomUUID() }` (`store-probe.ts:67`) reused across `startRun`/`settleRun`/`enqueue`/`dequeue`.
- **Proposed restructuring:** Keep `store-probe.ts` as a single `Effect` program using `ChildProcessSpawner` + `Stream` (or a shared probe helper in `packages/runtime/scripts/`), `Effect.sleep`, `FileSystem.makeTempDirectoryScoped`, and `PlatformLive`, and reuse `startRun`/`settleRun` from `scripts/store-fixtures.ts`. Note: `store-probe.ts` is explicitly exempted from the `#platform` import rule (`docs/plans/m1-core-loop.md`, commit `8aaf3ef`), so rewriting it is lower priority than `src/store/`, but shrinking it by ~120 lines removes the worst imperative boilerplate in PR 4.
- **Estimated line delta:** Removes ~100–130 lines from `store-probe.ts`.
- **Risk and guarding tests:** Low risk; `contract.test.ts:1164` spawns `store-probe.ts kv-write` as a subprocess, so CLI flags and JSON output format must stay unchanged.
- **Target PR and ripple:** **PR 4** (`m1/3-store`), with PR 8's `store-fixtures.ts` consolidation.
- **Effect API verification:** Verified `ChildProcess` / `ChildProcessSpawner` already in use at `packages/runtime/test/store/contract.test.ts:4-5, 1163-1167`.

---

### E6. `sqlite.ts` omits `Effect.fn` tracing and exposes manual `registerHolder`/`dropHolder` instead of scoped resource acquisition

- **Location:** `packages/runtime/src/store/sqlite.ts:218-651`, `packages/runtime/src/store/ThreadStore.ts:263-264`
- **Why it costs maintainers:** None of the 28 store methods use `Effect.fn("ThreadStore.<name>")` (unlike `execution/messages.ts:141, 220` and `execution/assemble.ts:40`), losing span names and call-site stack traces on SQLite errors. Separately, `registerHolder` and `dropHolder` form a manual acquire/release pair that `ThreadSupervisor.ts:302-310` has to wire up with `Effect.addFinalizer` by hand—and `claims.test.ts:267` forgets to release.
- **Proposed restructuring:** Define store methods with `Effect.fn("ThreadStore.<method>")` (or `Effect.fnUntraced` on hot read methods like `revision` if span overhead matters) and replace `registerHolder` + `dropHolder` with a scoped `acquireHolder` using `Effect.acquireRelease` (see S8).
- **Estimated line delta:** ~0 lines.
- **Risk and guarding tests:** Low risk; guarded by `contract.test.ts` and `claims.test.ts`.
- **Target PR and ripple:** `Effect.fn` in **PR 4** (`m1/3-store`); `acquireHolder` in **PR 8** (`m1/6-queue`).
- **Effect API verification:** Verified `Effect.fn` (`node_modules/effect/dist/Effect.d.ts:19640`) and `Effect.fnUntraced` (`Effect.d.ts:19516`).

---

### Opt-in `effect-tsgo` diagnostics reviewed and deliberately NOT recommended

For completeness, running all rules from `node_modules/@effect/tsgo/schema.json` on `packages/runtime/src/store/` also emitted:
- `preferSchemaTaggedError` (11 in `ThreadStore.ts`): `Data.TaggedError` is appropriate for internal domain errors that are never serialized over the wire; converting 11 classes to `Schema.TaggedError` adds boilerplate without value.
- `cryptoRandomUUIDInEffect` (3 in `sqlite.ts:175, 226, 282`): `SecureRandom` in `effect/crypto` (`node_modules/effect/dist/crypto/SecureRandom.d.ts`) is `@stability unstable` in 4.1.5 and would add a `SecureRandom` layer requirement across tests for little benefit unless deterministic UUIDs are desired.
- `deterministicKeys` (`ThreadStore.ts:277`): expects `spindle-runtime/store/ThreadStore`, whereas the whole codebase uses `spindle/<Name>`. Keep repository-wide convention.
- `apiStabilityLeak` (12): expected because `effect/sql` (`SqlClient`, `SqlError`, `MigrationError`) is marked `@stability unstable` in Effect 4.1.5.
- `preferEffectArray`/`String`/`Record`, `strictBooleanExpressions`, `yieldInCallArgument`: stylistic noise across the repo.

---

## 4. Duplication with code from other pull requests

- **`startRun` / `settleRun` / `claim` fixtures:** `packages/runtime/scripts/store-probe.ts:52-67` is a verbatim copy of `packages/runtime/test/store/contract.test.ts:15-30`. Both files already import from `packages/runtime/scripts/store-fixtures.ts`—move both helpers there (PR 8).
- **`isRecord` predicate (13 copies across `src/`):** `store/schema.ts:182` is duplicated in `registry/load-packages.ts:18`, `registry/validate.ts:64`, `execution/thread-state.ts:86`, `execution/turn.ts:53`, `execution/hooks.ts:59`, `execution/ThreadSupervisor.ts:65`, `execution/tools.ts:27`, `execution/assemble.ts:19`, `execution/call.ts:27`, `execution/messages.ts:47`, `providers/config.ts:14`, and `providers/openai-compatible.ts:29`.
- **`isCount` predicate (4 copies):** `store/sqlite.ts:98` and `store/schema.ts:215` are duplicated in `execution/hooks.ts:107` and `execution/ThreadSupervisor.ts:68`. All four are `Schema.is(Schema.Natural)`.
- **`nowMicros` (2 copies):** `store/sqlite.ts:85` is duplicated verbatim in `execution/messages.ts:45` (PR 7).
- **`QueueMessageInput` validation (2 copies):** `store/schema.ts:229-235` (`isQueueMessage`) duplicates the field checks in `execution/ThreadSupervisor.ts:81-99` (`queuedMessage`, PR 8). One `QueueMessageSchema` in `store/schema.ts` serves both.
- **Default `Message` projection / `noSubagent` (2 copies):** `store/schema.ts:117-149` (`noSubagent` + `toMessage`) duplicates the nine null subagent fields and default values in `execution/messages.ts:51-78` (`messageOf`, PR 7).
- **Stored `tool_calls` JSON parsing (2 copies):** `store/schema.ts:185-203` (`callsIn`) and `execution/assemble.ts:124-142` (`toolCallsOf`, PR 6) both hand-parse the same `tool_calls` JSON column.
- **Probe script CLI/benchmark boilerplate:** `scripts/store-probe.ts` (PR 4) duplicates `option`, `median`, and Node/Bun interleaved subprocess benchmarking with `scripts/step-probe.ts` (PR 6), `scripts/hook-probe.ts` (PR 7), and `scripts/queue-probe.ts` (PR 8).

---

## 5. What is good and should not be touched

- **NUL-byte and Unicode fidelity (`schema.ts:7-28`, `sqlite.ts:87-90, 153-160`):** `TextDecoder("utf-8", { ignoreBOM: true })`, `textColumn` casting NUL-bearing TEXT to BLOB for `node:sqlite`, lone-surrogate replacement on scalar writes so write-return matches read-return, and `KeyNotWellFormed` rejection on KV keys are hard-won cross-driver guarantees backed by thorough tests.
- **Single-pass strict `toJson` (`schema.ts:246-332`):** Validating and serializing in one read pass with cross-realm plain-object checks, `toJSON` rejection, depth 1000 cap, and `ValueNotJson({ field, path, found })` is well-engineered and guarded by 8 subtle tests in `contract.test.ts:1027-1158`.
- **SQLite pragmas, `STRICT` tables, and migrations (`sqlite.ts:51-58, 108-110`, `migrations/0001–0004`):** `PRAGMA foreign_keys = ON`, `PRAGMA synchronous = FULL`, `STRICT` tables, `CHECK` constraints, and `Migrator.fromRecord` are clean, idiomatic Effect SQL.
- **Deferred read transactions (`sqlite.ts:364, 408`):** Using `Effect.provideService(BeginTransaction, "BEGIN")` on `history` and `getMessages` gives snapshot isolation across count+page and revision+rows without taking `BEGIN IMMEDIATE`'s writer lock.
- **Revision triggers + nested-transaction `revision: null` guard (`migrations/0002_revision.ts`, `sqlite.ts:295, 342, 365-369`):** Keeps `history.ts`'s cache sound across arbitrary writers and rolled-back outer transactions without per-step full-table reads.
- **`Scheduler.PreventSchedulerYield` protection (`sqlite.ts:67-83`, `claims.test.ts:400-429`):** Solves a real Effect-v4 concurrency hazard for synchronous `queueTool` calls; keep the guarantee even if the wrapper is rewritten to be type-safe (E3).
- **Typed error channel (`ThreadStore.ts:55-174`):** Domain errors are `Data.TaggedError` classes with clear messages (except `ThreadNotFound`, `MessageNotFound`, `QueueEntryGone` which could also define `message`), and SQL failures stay typed as `SqlError` rather than `unknown`.

---

## 6. What I could not judge and why

- **Removing `insertMessage`'s pre-insert `SELECT 1 FROM messages WHERE id = ?` (`sqlite.ts:321-322`):** In principle the `UNIQUE` constraint on `messages.id` (`0001_threads.ts:23`) could map directly to `MessageIdTaken` via `SqlError`, saving one query per insert. I did not run both `@effect/sql-sqlite-node` (Node 22) and `@effect/sql-sqlite-bun` (Bun 1.4.5) to confirm whether both drivers populate the same `SqlError.reason` shape for a `UNIQUE` violation on `messages.id`, so I left it out of the findings.
- **Cold-read performance of Effect `Schema` decoding on 5,000-message threads:** `docs/plans/m1-core-loop.md:857` notes that a full `history` read of 5,000 messages takes ~11 ms on Node today. Switching `toMessage` from a plain object literal to `Schema.decodeUnknownSync(MessageRowSchema)` could add measurable per-row overhead on that cold read on Node 22 or Bun 1.4.5; this should be timed with `step-probe.ts run --seed 5000` if `toMessage` is converted (whereas `ThreadRow`, `AttachmentRefSchema`, and `decodeQueued` have negligible call frequency).
- **Exact M2–M4 store boundaries:** `docs/design/thread-ownership.md:176-181` and `docs/design/message-invariants.md:56-60` preview handlers, nested prompts, scheduled effects, and thread files. The proposed 3-service split (`ThreadStore`, `MessageStore`, `RunStore`) fits M1 cleanly, but whether `RunStore` later splits queue/schedule from claims depends on M2/M4 details not yet designed.
