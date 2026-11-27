BLOCKS: 0

Review of PR 20 (`m1/17-tool-timeout`, head `f71b9d0`, base `0ae1c18`). Effect claims were checked against the installed `effect@4.1.5` sources (taken from a sibling worktree's pnpm store, because this worktree has no `node_modules`).

## Defects

None of the defects I found block.

One defect that does not block, from the "also look at" list: **the presenter override hides another flag's error.** In `packages/runtime/src/cli/main.ts:33`, if any error in an `InvalidInvocation` is an `InvalidValue` for `tool-timeout`, the whole event is replaced by one note. Parse errors accumulate (`effect/src/cli/internal/parser.ts`, `state.errors.push`; `Command.ts:3727`). So `spindle run --bogus --tool-timeout` shows only the tool-timeout note: the `UnrecognizedOption --bogus` error and the help text are lost. **Ran it:** a few-line copy of the override on effect 4.1.5 gave errors `[UnrecognizedOption:--bogus, InvalidValue:tool-timeout]` and printed only the note. Smallest fix: take the override only when `event.errors.length === 1`, or pass the event on with that one error removed and print the note as well. It costs one extra run for the user, not data.

## Question 1: did a hook's behavior change? No.

The base ran `timeoutOption(tryPromise)` and then `result`. In 4.1.5, `timeoutOption` is `raceFirst(asSome(self), as(sleep(d), none))` (`internal/effect.ts:4000`). The head runs `raceFirst(asSome(result(work)), as(clock.sleep(d), none))` with the work first, does not fork (no `toolScope`), and keeps the wall clock (`currentTimeMillisUnsafe`) and the strict `>` check. A hook's ThreadState is built with `call` and not `callback` (`step.ts:183`, `thread-state.ts:396`), so neither `pastDeadline` nor the new `terminate` check reaches a hook. For each case the outcome, the problem text, and the moment of expiry are the same as the base:
- **Returns in time:** `{value}`, and the callback does not expire.
- **Throws:** `"threw an error"`, or `"did not settle…"` if it was also over the limit (the base gave the same).
- **Never settles:** the timer wins, then `expire()` in the same tick and `"did not settle within X"`.
- **Settles after the limit:** the same as "never settles". The late value is dropped.
- **Blocks past the limit, then returns:** the work runs first, so the timer is armed after the block. The work wins, the wall-clock overrun check fails, and it expires with the timeout text. This is identical to the base.
- **Aborted while running:** it runs in the step fiber in both versions, the race's losers are interrupted, `expire()` is never reached, and the callback stays live until the hook settles. This is identical to the base.

## Question 2: the blocking list. I found nothing that meets it.

## What I checked and found sound
- **Window between the timer firing and `expire()`:** handle checks use `pastDeadline`, which reads a monotonic `#overdue`. Expiry is set before `#release` runs (ran it: `expired` was true at release).
- **A write submitted before the limit and committed after:** `authorize` re-checks `origin.expired()` inside `BEGIN IMMEDIATE` (`database.ts:51`, the stores). A write that reaches that check after the limit is refused. One that passed it commits before the settle can take the lock.
- **One result per call:** `raceFirst` settles once. If the tool returns late or both arrive at once, the overrun check maps it to one timeout. A synchronous throw with a limit gives one `threw` result (ran it).
- **During an abort or terminate:** the forked fiber lives in the execution's `Effect.scoped(publish)` scope. It is a daemon in `forkIn`, so interrupting the step does not interrupt it. The hold is released at the limit and the handle is already refused by `signal.aborted`.
- **Exit or displace:** the latch opens at once, and closing the scope interrupts the race, which clears the timer through `clearTimeout` (`effect.ts:6441`).
- **No leak per call:** `forkIn` removes its scope finalizer when the fiber exits (`effect.ts:5745`), and the losing `sleep` is cleared. Ran it: a 30 s limit on a tool that returned in time let the process exit at 63 ms.
- **Late rejection:** `tryPromise` attaches both handlers, and an unjoined failed fiber is not reported in 4.1.5. Ran it: no `unhandledRejection`.
- **Timer first with a tool that returns synchronously:** ran 300 trials per limit. At 1, 2 and 5 ms there were 0 false timeouts. At 0.01 ms the time really passed the limit.
- **`queueTool` and `invokeTool` targets:** both go through `executeTool` with the same `toolContext`, so the same limit applies (`drain.ts:75`, `tools.ts:209`).
- **`Effect.scoped(publish)`:** only the new `Effect.scope` in `prepareSide` depends on it. Nothing else inside a run was scoped. `resume` forks into the supervisor's scope.

## Points of structure
- `within` changes three things at once on `toolScope`: the clock, the order of the race, and whether it forks. A named options object would show that the hook path and the tool path share less than they appear to.
- A tool that times out does not bound a tool it started with `invokeTool` that has no limit of its own. That tool keeps a live handle and its hold after the outer tool's limit. The base already allowed this through an un-awaited `invokeTool`.
- `--tool-timeout 60 --tool-timeout 30` keeps 30 without a word, while a repeated `NAME=` is an error. `Number()` also accepts `0x10` and `" 10"`.

## What I could not judge in the time
I did not drive `spindle run` or `chat` end to end through an abort that waits for a tool's limit. I relied on reading `Execution.ts` and the builder's tests. I did not test timing on Bun.

Every process ran under `perl setpgrp; alarm`, and none is left. The scratch scripts are in `/tmp/review10-scripts`. The worktree is clean, detached at `f71b9d0`.
