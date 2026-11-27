BLOCKS: 1

That one blocking finding (D1) is a gap the base already had and `28c6744` leaves open; it is not a regression. Neither commit adds a blocking defect. D2 is a regression that does not meet the blocking bar.

## Defects

**D1. A caller renamed by a hook that also adds or removes an earlier message still loses its result. Blocking in kind, not a regression.** `packages/runtime/src/execution/assemble.ts:373-387`. The fix compares the hook's message only with the stored row at the same index (`rows[index]`). If a hook renames callers and also prepends one message, or drops the first one, every renamed caller misses that row. It gets no `seq`, so its result is hidden and the request carries the call without its result. **Ran it** (scratch vitest, Node, two `dup` callers). Rename plus prepend and rename plus drop-first both give `assistant first(dup), assistant second(dup)` with no tool messages, the same output as the base `e410aae`. Rename alone, the case the commit names, is fixed. Smallest fix: when the positional match fails, look the message up by its content without the id (for example `tool_calls` plus `created_at`) among stored rows whose id is absent from `filtered`, and accept a match only when it is unique. Or record it in the plan as an accepted limit.

**D2. Regression: a crafted hook value can now end the run on Bun.** `assemble.ts:382`. `Equal.equals` hashes the hook's whole message, including `metadata`, recursively. `acceptMessages` checks only that `metadata` is an object. On Bun, `structuredClone` accepts metadata nested 15,000 to 30,000 deep, and then `Hash.hash` overflows the stack. Smallest input: a `filter_messages` hook that returns a caller with a new id and metadata `{a:{a:…}}` nested 15,000 deep. **Ran it** under `bun --bun vitest`. At HEAD the run ends `failed (fatal_error)`, "Maximum call stack size exceeded", with one request. At `e410aae` the same input completes (`idle`, two requests). This also happens on every later step while the hook keeps doing it. On Node the clone fails first and the hook's return is refused, so Node does not show it. Smallest fix: wrap the comparison as `try { … } catch { false }`. Effect's `Hash` and `Equal` unwind their own state in `finally`. Or compare only `role`, `content`, `tool_calls`, `tool_call_id`, `created_at`, and `metadata` by `JSON.stringify` under the same try.

**D3. Pre-existing, not from these commits: hook-assigned ids override position.** `assemble.ts:387`. If a hook swaps the ids of two stored callers that reuse `dup`, the request pairs result `two` (tool `second`) with call `first`, and `one` with `second`. If it gives caller A the id of B and B a fresh id, A gets B's result and B is sent without one. **Ran it**. HEAD and base give the same output. This is the `byId` path, which the commit does not touch. The design treats an id as identity, so this may be intended. I note it because the brief asked about swaps.

**D4. Minor, `3dc85bb`: memory chat interrupted during the creation hook prints only part of O1.** `chat.ts:86`. A signal in the new window prints `spindle: thread <id>` from the release. It does not print the `no --db…` line, which runs only after `createThread` returns. It correctly prints no resume line. Reasoned from the code, not run. Fix: print the memory note inside `reportId` when `filename === ":memory:"`.

**D5. Pre-existing, `--thread` only:** `chat.ts:90-106`. A signal during the open transaction, or between its commit and `reportId`, leaves `openedId` unset, so chat exits with neither O1 nor O14 for a thread that is stored and resumable. Any `recoverThread` repair rolls back or stays. The base behaves the same, the user typed the id, and the contract does not define an interrupt during start. Reasoned, not run.

## Checked and sound

- `Equal.equals` in effect 4.1.5 is structural for plain objects, arrays, Map, Set, and Date, and safe on cycles (`node_modules/effect/src/Equal.ts`, `Hash.ts`). Hook output is `structuredClone`d and checked with `isMessage` first, so no getters, proxies, or class instances reach it.
- A restored `seq` is unique. The original id must be absent from `filtered`, so no other entry can claim the row by id, and the positional slot is used once. No result appears twice, and no result shows without its caller.
- A restore needs content equal to the stored caller except the id, so its `tool_calls` are that caller's and the pairing is correct. A reordered list, a different message, or a changed field falls back to the base behaviour (scratch runs: reorder or shift, duplicate, metadata changed).
- A copy kept beside its original is not restored (`retainedIds`). Duplicating a caller with fresh ids gives the stored `seq` to the first copy only.
- The fix returns the stored row (the original id), so past visibility is the stored one. Nothing a hook returns reaches the store.
- Work per step: `byId` and `retainedIds` are built lazily, once per assembly and only on an id mismatch, plus one `Equal` per renamed caller. That is linear, the same order as the existing copy and clone of the history. Stored rows are never mutated, so Effect's hash cache cannot go stale.
- `acquireUseRelease` in 4.1.5 (`internal/effect.ts:4514`) runs `acquire` uninterruptibly and always runs `release` after `use`. `ThreadStore.createThread` commits as its last action, so a committed thread always reaches `reportCreated`.
- Successful start: the id still prints after the hook and its output, then the memory note. The order is unchanged for chat and run.
- A signal before the commit is deferred to after it, then the id is printed. A signal during the hook prints the id, then O14 for `--db`, from the uninterruptible tail. A signal after the commit gets the same tail. Each line prints once.
- A second signal calls `interruptUnsafe` again on a fiber that is already interrupting. The release and the tail are uninterruptible, so nothing prints twice and the exit is not cut short.
- A hook failure or timeout is logged and passed over in `pipeline`, so the thread, the output, and the exit code are as at the base. A typed failure of `atRest` now prints the id and O14 before the error. That is a change, and it matches O14 for a stored thread.
- An unknown agent, definition errors, and a database that cannot be opened fail in `withProject` before `createThread`. `openedId` stays unset, nothing extra prints, and F01 holds.
- `run`: with `--db` the id prints once from the release, including on interrupt, and never for `:memory:`. For the `{thread}` target it prints once, as at the base.

## Structure

- The pairing that request assembly rebuilds after `filter_messages` now has three heuristics: same id, same index, and rename-in-place. A single matcher, documented in the plan with the cases it gives up on (D1, D3), would be easier to audit.
- `reportId` in chat now carries state (`openedId`) and output. Returning the opened id through the exit would avoid the mutable `let`.
- D2 is the general risk of running a deep structural compare on hook output. A depth or size bound in `acceptMessages` would close it for every later consumer.

## Not judged, and hygiene

- I did not run the CLI under real signals. The 3dc85bb paths are reasoned from the code and the Effect sources.
- I did not check the exit code for Ctrl-C during the hook against "exit 0 at the prompt". The code path is unchanged, and the contract does not cover it.
- Dependencies were installed with `pnpm install --offline` in the worktree. The scratch tests were removed, and `git status` is clean. Copies are in `/tmp/structure/review-11/scratch/`. Every process ran under a process-group alarm, and `pgrep` shows none left.
