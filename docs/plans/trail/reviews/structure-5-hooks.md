BLOCKS: 0. SHOULD FIX: 4.

# Review of PR 15, `m1/12-hooks` at `45b7ab7`, against `89a85c2`

Reviewer: Claude Opus 5.5. Everything below was read or run by me. No helper agents were used. Files are cited at the head commit. All scripts, transcripts, and outputs are under `/tmp/structure/review-5/`. The machine's load average was 31 to 41 on 24 cores for the whole session, so every timing here is inflated.

## BLOCKS

None. I found no change in behavior, no new way to leak a secret, no change to stored data, and no tool call left without a result.

### What I ran for point 1 (did behavior change?)

1. **Differential replay, 600 seeds, base against head, Node and Bun.** `replay/replay-a.test.ts` (seeds 1 to 300) and `replay/replay.test.ts` (seeds 1001 to 1300) build one world per seed: one to four hooks at seeded positions with seeded behaviors, agent and prompt hook lists (sometimes with a duplicate id), side A or side B human, seven tools (echo, a tool that throws, a tool with an unstorable BigInt result, one that injects, one that calls `state.execution.stop()`, one that reads `execution.messageHistory`, one that learns a secret), a seeded model script with tool calls and reasoning, one to three sends, and at-rest injections, updates, and `queueTool` calls between sends. The hook behaviors are a valid return (several per position), an invalid one, a throw, never settling, settling late, blocking the thread past the limit, mutating every nested object of the arguments and then failing, mutating and returning, writing to the thread from inside (including writes nested until the depth limit), learning a secret with `state.env`, and exotic returns (a throwing getter, a getter that changes, a proxy, a class instance, a value from another realm via `node:vm`, a sparse array, a `Date`, a BigInt, a `toJSON` method, a frozen object, a null-prototype object, and arrays carrying record fields). Each seed records every hook call with a canonical copy of its arguments (holes, `undefined`, prototypes, getters, and shared references kept), what each hook's own writes returned, every stored row, every provider request, every outcome with its trace, and every log line.
   - Batch A: 300 of 300 identical on Node. 299 of 300 on Bun. The one difference (seed 287) is my harness: a hook that waits on a nested hook which itself runs into the same 300 ms limit finishes at its own limit. Four reruns at each revision gave the identical log sequence at base and head (`replay/s287-*.jsonl`).
   - Batch B: 300 of 300 identical on Node and on Bun. It reached the nested-write limit 22 times, `MessageIdTaken` on injection 47 times, taken-id refusals 67 times, and both system-secret failures (22 and 39 times).
   - Base on Node and base on Bun are also identical to each other, so the replay is deterministic.
   - Outputs: `replay/{a,b}-{base,head}-{node,bun}.jsonl`. Comparison: `replay/compare.py`.
2. **Isolation, eleven positions** (`replay/isolation.test.ts`). At each position, hook A mutates every nested object of its arguments in place and throws, and hook B records what it receives. A tool reads `execution.messageHistory` on every step of a four-step execution, with past chat and past tools included. The dump is byte-identical at base and head on both runtimes, and the marker never appears in hook B's view, the history reads, the stored rows, or the requests (`replay/iso-{base,head}-{node,bun}.jsonl`).
3. **The two rechecks against the final secrets** (`replay/rechecks.test.ts`). A first hook writes a secret it has not registered, and a later hook in the same operation learns it. The leading system prompt fails the run before dispatch (learned in `filter_messages` or in `prefilter_llm_history`). The chosen id is dropped on a required write ("Spindle kept the generated id") and refuses an injection. Identical at base and head on both runtimes, with no leak (`replay/rk-*.jsonl`).
4. **Prefilter `Schema` against the base predicates**, 200,000 seeded values per runtime after `structuredClone`, copying the base predicates verbatim (`fuzz/base-predicates.ts`, `fuzz/prefilter.test.ts`). Zero disagreements on acceptance, and the conversion back with `fromLLMMessage` is identical for all 84,327 accepted values. Direct probes (`fuzz/probe.txt`): a throwing getter, a proxy, a proxied array, and a function fail the clone first at both revisions. A sparse array, a sparse parts list, a sparse call list, an array standing in for a message, a function record, or an `image_url` record, a boxed string, and a `Date` in arguments are rejected at both. A class instance, a value from another realm, a null-prototype object, and an own `undefined` content are accepted at both. `Schema.Natural` is `Number.isSafeInteger(n) && n >= 0` (`node_modules/effect/dist/Schema.js:4684-4726`), the same as the base `isCount`.
5. **Do the checks have teeth?** I planted six defects in scratch clones of head (`replay/mutants.sh` and the commands in `replay/*mut*`):
   - First filter hook gets a shallow copy of the history: the isolation test shows the leak at `filter_messages` (`replay/iso-mut-filter.jsonl`). The random replay did not see it in 100 seeds, because a new execution re-reads history from the store.
   - First prefilter hook gets shallow copies: isolation shows the leak, and the replay catches it in 1 of 100 seeds.
   - Redaction with a snapshot of the secrets taken before the hooks: the replay catches it in 5 of 100 seeds, including a secret in a stored row (`late sb-1016-late`) and in stored ids.
   - Final system-prompt recheck removed: the recheck test leaks in both system cases. The random replay did not catch it.
   - Final id recheck removed: the recheck test leaks in both id cases.
6. **Reading.** Every base caller of `createMessage` maps to one path at head. The injection at `thread-state.ts:261` goes to `injectMessage`. The model response (`step.ts:258`), a delivered queued message (`drain.ts:112`), a queued call (`drain.ts:52`), a tool result (`tool-lifecycle.ts:86`), and `history.test.ts:272` go to `commitMessage`, with the base writer's fields, error-code rule, `finish`, and `dequeue`. The skipped result keeps `keepErrorCode: false` as the base `"skipped"` writer did. The queued re-redaction parses the same pre-hook text that base parsed. The stop check sits at the same five boundaries in the same order: before the drain, after it, before dispatch (`assemble.ts:413`), before each call (`tool-lifecycle.ts:67`), and after the tools. `run.abortEnd` equals what `stopAtBoundary()` returns (`Execution.ts:76-84`). Only the first `filter_messages` hook and the first `prefilter_llm_history` hook get something other than `structuredClone`, and `copyMessage` is a deep copy of every stored field, because every cached message is built from a row (`MessageStore.ts:76`, `94`) or by `copyMessage` (`history.ts:10-17`). The at-rest scope built by `atRestHooks` (`thread-state.ts:386-406`) gives the same fields, the same execution owner, and the same fresh or shared `context` as the two scopes it replaced.

## Point 2: is it the simpler shape?

Better than base, but not the simplest shape. It moves more code than it deletes, and three of its additions cost lines without need.

**What got simpler.**
- The cast and the conditional error type are gone. `HookFailed` can only come out of `vetoHooks` (`hooks.ts:476-482`), so the step loop's error channel no longer carries it.
- The five-way `Writer` switch is gone. `messages.ts` has two writes over one preparation (`messages.ts:124-203`). The queued and skipped special cases now sit with the code that makes those messages, as `finish` policies (`drain.ts:64-69`, `tool-lifecycle.ts:86-99`).
- `step.ts` lost its 450-line closure. The loop reads top to bottom in `step.ts:298-353` and calls the hook runner zero times. Hooks are now called from `assemble.ts`, `messages.ts`, `tool-lifecycle.ts`, and `trigger.ts`.
- The request-message predicates became a 46-line `Schema` union with a typed conversion and no casts (`llm-history.ts:5-50`, `103-136`).
- The at-rest hook scope is built once (`thread-state.ts:386-406`) instead of in `trigger.ts` and again in `step.ts`.

**Is `hooks.ts` three kinds over one pipeline, or the old table with new names?** Mostly the old table with new names. `observers` and `transforms` (`hooks.ts:192-243`) are base `POSITIONS` split in two. The `failure` column became a choice of entry point. `pipeline` (`hooks.ts:385-424`) is base `runHooks`'s loop: the `essential` flag became an optional `refuse` callback, and the `after_thread_created` special case became an `args` closure. The "three kinds" are three doors into one loop that differ only in whether they pass a transform row and a `refuse`. That is a reasonable design. The real gain is in the types, not the shape. `pipeline` takes nine positional parameters. Its callers read `where` and `action` from the row and pass them back in, and `transform` (`hooks.ts:443-466`) exists only to do that and forward.

**The new modules.**
- `drain.ts`: one thing, the queue drain. It takes a prompt `ToolContext` only to reach `turn` for queued tools, and imports three helpers from `tool-lifecycle.ts`.
- `tool-lifecycle.ts`: one thing.
- `llm-history.ts`: one thing, the `LLMMessage` boundary. It also holds `copyRequestMessages`, which I would delete (SHOULD FIX 2).
- `response.ts`: the closest to a drawer. It holds response-to-calls, response-to-stored-message, the reasoning source, `argumentsOf` (used by `tool-lifecycle.ts`), and the stop-tool outcome, which reads results and config after the tools run. It also exports a second `toolCallsOf` (`response.ts:24`) beside the exported `toolCallsOf` at `assemble.ts:141`, with a different signature.

**Forwarding, one-use types, unset options, hiding helpers, repeated comments.**
- Forwarding: `transform`, `transformHooks`, and `vetoHooks` (`hooks.ts:443-482`) are three layers over one call to `pipeline`.
- `Session` and the log type are inferred with `ReturnType` (`step.ts:275`, `277`) where the extracted modules need a named contract.
- I found no option that no caller sets.
- `has` (`hooks.ts:271`) is `countHooks(...) > 0`.
- `llm-history.ts:111` says `hooks.ts` checked each message. The check now lives at `llm-history.ts:50`.

**What can be deleted without a change in behavior**, about 55 to 65 lines:
1. `llm-history.ts:88-101` and the prefilter `copyInitial` at `assemble.ts:404-406`. `structuredClone` already does this. About 16 lines.
2. `hooks.ts:443-466`, by letting `pipeline` take the row and the leading arguments and computing `where`, `action`, and the argument list itself (`hooks.ts:385-395`). About 15 to 20 lines.
3. The regex path in `toProviderMessages` (`assemble.ts:263-279`, `298`, `304`, and the `callsAt` parameter of `requestOrder` at `205-248`). This one needs an operator decision; see SHOULD FIX 1. About 10 to 15 lines.
4. Duplicate helpers: `isRecord` at `hooks.ts:64` and `messages.ts:48`, `object` at `llm-history.ts:25`, and `parseJson` at `response.ts:9-15`. About 12 lines.
5. `has` at `hooks.ts:271`.

**Would a different cut be smaller?** Somewhat, not dramatically. These are the two changes I would make:

```ts
// hooks.ts: one loop that reads its contract from the row it is given
interface Contract<V> { where: string; kept: string; expects?: string; accept?: (r: unknown, c: V) => V | typeof INVALID }
const run = <V, E = never>(scope, position, contract: Contract<V>, lead: readonly unknown[], value: V,
  { depth = 0, check, copy, refuse }: RunOptions<V, E> = {}) => /* base loop; args = clones of lead, plus a copy of
  current when contract.accept exists */
export const observeHooks = (scope, p, args, depth) => run(scope, p, OBSERVERS[p], args, undefined, { depth })
export const transformHooks = (scope, p, lead, v, o) => run(scope, p, TRANSFORMS[p], lead, v, o)
export const vetoHooks = (scope, p, lead, v, o) => run(scope, p, TRANSFORMS[p], lead, v, { ...o, refuse: Effect.fail })

// step.ts: name the two scopes the extracted modules need, and pass them whole
interface ThreadScope { run: Execution; history: History; delivery: WriteContext; events: StepEvents }
interface SideScope { turn: Turn; write: WriteContext; tools: ToolContext; view: HistoryView; provider: Effect.Effect<LLMProviderInterface> }
assembleRequest(side, thread)              // today: (turn, view, history, write, run, events)
completeCall(side, thread, seq, call, outcome)
drainQueue(thread, runQueuedTool)         // no ToolContext needed to deliver a message
```

With the deletions above, that would take the changed source from +144 to roughly +80. The rest is the price of four module boundaries (imports, exports, explicit parameters) and of validators the project's rules require. I think that price is worth paying for what the split bought.

## SHOULD FIX

**1. A regex in `toProviderMessages` decides whether to keep a crash** (`assemble.ts:263-279`, `298`, `304`, `315`, `requestOrder` at `205-248`). The eligibility skip is a real speedup on a long hidden past. My microbenchmark (`fuzz/bench.ts`, `fuzz/bench-{node,bun}.txt`) shows 3,000 rows with a hidden past at 5.5 ms on base against 1.8 ms on head on Node, and 1.5 ms against 0.25 ms on Bun. But skipping the parse would also skip `String(entry.function.name)`, which throws for a name like `{"toString":0}`. So the code sniffs the JSON text with `/\\u|"name"\s*:\s*[[{]/` (`assemble.ts:272`) and keeps calling `String()` (`assemble.ts:274`). That keeps a pre-existing defect: a `filter_messages` hook that returns such a `tool_calls` string ends the run with `fatal_error`, where the hook rules say a bad hook return keeps the last good value. `hook-history.test.ts:7-23` pins that crash as expected behavior. Smallest fix: ask the operator to let a non-string call name stop ending the run, for example by treating it as an empty name or dropping that call. Then delete `assemble.ts:270-276` and the pinning test, and keep the skip. If the operator wants no behavior change at all now, revert to base's single `parsed` list, which is simpler and slower.

**2. `copyRequestMessages` buys little and needs its own test** (`llm-history.ts:88-101`, `assemble.ts:404-406`). It reproduces `structuredClone`'s aliasing by hand for the first prefilter hook. Measured against `structuredClone`: 300 messages took 0.81 ms against 0.55 ms on Node (slower), 3,000 took 8.5 against 11.8 ms on Node, and on Bun it was 0.18 against 0.34 ms and 5.7 against 7.2 ms. A prefilter array is normally only the current exchange, because past turns are excluded unless `includeChat` is set. It also needs `hook-history.test.ts:25-61` to keep its aliasing promise. Fix: delete it and drop the prefilter `copyInitial`. The `filter_messages` copy (`assemble.ts:385`) is different: its input is the whole stored history on every step, and `copyMessage` already existed for that reason. Keep that one.

**3. `pipeline` takes nine positional parameters, and `transform` only forwards** (`hooks.ts:385-395`, `443-466`). Its callers look up `where` and `action` from the row and pass them back, and build an `args` closure that only the pipeline needs. Fix: pass the row and the leading arguments and let the loop compute the rest (sketch in point 2). This deletes the `transform` helper and about 15 to 20 lines. `Checks` (`hooks.ts:371-375`) also carries a copy strategy, a depth, and a check under a name that says "checks". `observeHooks` takes `depth` positionally (`hooks.ts:430`) while the others take it in options.

**4. The extracted step modules take four to six positional context arguments.** `assembleRequest(turn, view, history, write, run, events)` (`assemble.ts:363-370`) takes a whole `WriteContext` only to read `hooks` and `secrets`. Also `completeCall(context, write, events, callerSeq, call, outcome)` (`tool-lifecycle.ts:56-63`), `runQueuedTool(toolContext, write, events, entry)` (`drain.ts:26-31`), and `drainQueue(toolContext, write, delivery, events)` (`drain.ts:90-95`). Meanwhile `step.ts:275` and `277` derive the session and log types with `ReturnType`. Fix: name a thread scope and a side scope and pass them whole (sketch in point 2). This is small now, shrinks every one of these signatures, and is the seam milestone 2 needs (point 4).

## Point 4: will a second prompt side and a handler side fit?

The hooks and the message write already fit. Neither knows about sides:
- `messages.ts` takes a `WriteContext`, and its policies live with the callers.
- Hook selection is per prompt (`turnHooks`) or per agent at rest (`agentHooks`, `atRestHooks`).
- A handler's reply through `state.injectMessage` takes the injection path, which is what Handlers section 6 describes.

The step loop assumes one prompt side with a human on the other:
- `Turn` carries one `side` and one `human` (`turn.ts:43-51`, pre-existing). `prepareSession` builds a single session from that one turn: one hook set, one `ToolContext`, one provider, one `ExecutionState.side` (`step.ts:154-234`, `176`).
- `advance` ends the run with `awaiting_human` whenever the drain gave the prompt side nothing from the other side (`step.ts:306-311`). With two prompt sides, that is the moment the other prompt should take its turn. With a handler on the other side, it is the moment to invoke the handler.
- `turnStart` and `turnSteps` (`step.ts:296-297`) and `stopReason(..., turn.config, ...)` count one side's turn. Spec exchange counting (`maxSessionTurns`) spans both sides.
- `drainQueue` delivers every queued entry in one pass and then reports `{ prompted, first, count }` (`drain.ts:90-120`). It decides `prompted` by comparing roles with the one prompt side (`drain.ts:116`) and stores queued tools as calls of that side's prompt (`drain.ts:52-71`). Handlers section 4 needs one invocation per inbound message, in order, with later messages waiting, and a handler side has no prompt to own a queued call.

What this pull request should change now so milestone 2 does not undo it:
1. Split `prepareSession` into thread-scoped state (history, at-rest delivery hooks, events and log, secrets, control) and side-scoped state (turn, prompt hooks and their `WriteContext`, `ToolContext`, history view, provider, streamed tool hooks). Pass the side record whole to `assembleRequest`, `storeResponse`, and `completeCall` (SHOULD FIX 4). As written, milestone 2 would have to unpick a flat record keyed to one `Turn` and rewrite the six-argument signatures this PR just introduced.
2. Do not make message delivery depend on a prompt `ToolContext`. Pass `drainQueue` the queued-tool runner, or split message delivery from queued tools, and prefer an API that delivers one entry at a time with the loop around it. A handler side can then reuse delivery as is.

I am not proposing a design for the side alternation itself.

## Point 5: the two intermittent tests

Runs used `flaky.sh`, an instrumented copy of the head checkout where the Ctrl-C test adds the status process's stdout, stderr, and the chat output to its failure message (`chat-interrupt.test.ts:241-242` in `/tmp/structure/review-5/flaky`). Results are in `flaky-out/summary.tsv`. The full suite looped in another head checkout during the "beside" runs (`suite-loop.sh`, `flaky-out/suite/`).

**S22 is a fault in the test.** It sleeps through real retry backoff: 1,000 ms in the mid-stream case, 500 plus 1,000 ms in the cut case, and 500 ms in the native-timeout case. That is 3.0 s of fixed sleep (`call.ts:355-356`) inside vitest's default 5 s limit, because `conformance.test.ts:12` sets no timeout. Nine driver sessions, each with its own database, share the remaining 2 s.

| Runtime | Alone (30 runs) | Beside the suite (30 runs) |
|---|---|---|
| Node | median 3.87 s, max 4.59 s, 0 failures | median 3.97 s, max 5.17 s, 1 failure |
| Bun | median 4.07 s, max 4.92 s, 0 failures | median 4.11 s, max 4.77 s, 0 failures |

The failure is `flaky-out/beside-s22-node-9.log`: "Test timed out in 5000ms", at 5,171 ms. The backoff schedule is the runtime's intended behavior, and base and head take the same time (review 4b measured 3.65 to 4.38 s at both). Fix: give S22 its own timeout at `conformance.test.ts:12`. Better, make the backoff base a `Context.Reference`, as `HookTimeout` is, so the scenario does not sleep at all.

**The Ctrl-C status exit: cause not found.**
- 30 runs alone and 30 beside the suite on each runtime: 0 failures in 120.
- The whole `test/cli` directory with process tests in parallel workers: 15 runs per runtime. The Ctrl-C test passed in all 30. Three Node runs failed, all on the `chat-shared` race below (`flaky-out/cli/summary`).

In all, the Ctrl-C test passed 150 times out of 150.

`spindle status` exits 1 only through `fail(...)` (`cli/status.ts:37-43`), which prints `spindle: <message>` on stderr. The test discards that stderr, which is why the implementer's one failure cannot be diagnosed. A plain lock wait is unlikely to be the cause, because both SQLite clients set WAL and a 5 s busy timeout (`@effect/sql-sqlite-node/dist/SqliteClient.js:75-97`). Nothing points at this pull request: the test, the CLI, and the store are unchanged by it. I cannot say whether it is a runtime or a test fault. Smallest step: put `status.err()` in the assertion message, as my copy does, so the next failure names its cause.

**A third intermittent test, found while looping:** `chat-shared.test.ts`, "when the reader of standard output goes away…". It failed four times, all on Node: once in 6 full-suite runs and in 3 of 15 CLI-directory runs (`flaky-out/suite/7-node.log`, `flaky-out/cli/node-{3,12,15}.log`), each with `expected [] to deeply equal ['1']`. It never failed on Bun. This is a fault in the test. The shell creates `chat-exit` when it opens `> "$SPINDLE_GATE_DIR/chat-exit"`, before `echo` writes the code (`chat-shared.test.ts:301`), and the test reads the file as soon as it exists (`chat-shared.test.ts:309-310`). Fix: wait until the file holds a line, or write to a temporary name and `mv` it.

## Point 3: Effect usage

`pnpm exec effect-tsgo tsc --noEmit -p tsconfig.json` exits 0 at both revisions (`tsgo-{head,base}.log`).
- Head reports four suggestions, none in touched files: `providers/script.ts:27` and `28` (`schemaNumber`), and `registry/validate.ts:525` and `584` (`tryCatchInEffectGen`).
- Base reported seven. The three that are gone are `hooks.ts:456` (`unsafeEffectTypeAssertion`), `hooks.ts:495`, and `tools.ts:128` (`tryCatchInEffectGen`).
- `unsafeEffectTypeAssertion` is now an error (`tsconfig.json:39`), and head is clean under it.

Usage notes, checked against `node_modules/effect`:
- Passing `Effect.fail` as `refuse` (`hooks.ts:482`) types the veto error channel without a cast. That is fair.
- `accept` (`hooks.ts:377-383`) moves a `try` out of the generator to satisfy the linter, which is fine.
- `Effect.cached` with `Effect.flatten` (`step.ts:366-371`) keeps base's one-time setup.
- `messages.ts:186` keeps `Effect.orDie` on purpose, so a database error still ends the run as `fatal_error`.
- The `Schema` in `llm-history.ts` is partly hand-written predicates wrapped in `Schema.declare` (`llm-history.ts:24-27`, `43`). The `(u): u is ContentPart => isPart(u)` guards assert the spec types rather than prove them. `objectText` calls `JSON.parse` inside a predicate, so the exported guard `isRequestHistory` throws on argument text that is not JSON, where base returned false. Behavior is the same only because its one caller catches (`hooks.ts:377-383`).

## Notes

- `isRequestHistory` throws instead of returning false on non-JSON argument text (`llm-history.ts:27`). A future caller without a `try` would crash.
- Two exported functions share the name `toolCallsOf` with different signatures (`response.ts:24`, `assemble.ts:141`).
- `isRecord` now has 13 copies in `src/`, and `llm-history.ts:25` adds a fourteenth named `object`. `parseJson` is duplicated (`response.ts:9`, `assemble.ts:25`).
- Stale comment at `llm-history.ts:111`.
- `WritePolicy` mixes the store link `dequeue` with redaction policy (`messages.ts:115-120`).
- `hook-history.test.ts:7-23` pins a pre-existing crash as expected behavior. Label it, or move it to the follow-up list with SHOULD FIX 1.
- Pre-existing: a `filter_messages` hook returning a crafted `tool_calls` name ends the run with `fatal_error` (`assemble.ts:149`, `274`). This belongs on the follow-up list.
- Pre-existing: a dispatched request's `extraContent` objects are the history cache's own metadata objects (`assemble.ts:146-151`), so a provider that mutates its request edits the cached history.
- Missing blank lines between top-level declarations at `tool-lifecycle.ts:20-21` and `53-54`, and at `drain.ts:86-87`.
- The random replay never reached the id-collision retry or a late-learned id on a required write. I covered the second with `replay/rechecks.test.ts`. The first is covered by I2 and the implementer's double-collision reproducer.
- The exports this PR removes are internal. The package exports only `.`, which re-exports `openaiCompatible`.
- The implementer's line counts check out: 1,836 to 1,500 in the four targeted modules, and +144 across changed source.
- During this review the full suite ran 12 times at head beside the loops, and 11 passed with 535 tests. The one failure is the `chat-shared` race above.
