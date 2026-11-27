BLOCKS: 2

Review of PR 18 (`m1/15-model-call`, head `6230b71`, base `3bd6949`). I read the code and ran two short probes. The probes are in `/tmp/structure/review-8/scratch/`: `sse.mjs` and `cleanup.ts`.

## Behavior changes not covered by the exceptions, and new ways to go wrong

**1. An event is now delivered only at a blank line, not at the end of its `data` line.** The base sent each `data:` line on as soon as its line ended. The head uses the WHATWG rule: data lines are joined until a blank line, and the event is sent then. Exception 2 lists one JSON value split over two `data` lines. It does not cover the reverse, or the timing.
- *Two complete values separated by a single LF:* `data: {"a":1}\ndata: {"b":2}\n\n`. The base yields two events. The head yields `{"a":1}\n{"b":2}`, and `streamChunks` turns that into a "not JSON" error chunk (`providers/openai-compatible.ts:333`). That error has code `unknown`, so it is not retried and the run fails with `step_error`. The same stream succeeded at the base. **Ran it** (`sse.mjs`, case `twoValuesOneLF`).
- *`[DONE]` or the finish event ended by one LF on a connection the server keeps open:* the base saw `[DONE]` and finished. The head waits for a blank line or the end of the body. That means a provider timeout if one is configured, and a hang if not. **Ran it** (`doneOneLFHeldOpen`, `finishOneLFHeldOpen`).
- The builder's matrix has no case for either input (`probe.mjs:24-35`). I can't say how common single-LF framing is among real OpenAI-compatible servers.
- *Smallest fix:* if WHATWG framing is the intended contract, add both inputs to the stated exceptions and add a test for each. No code change is needed. If tolerance matters more, the fallback is to parse each line of a multi-line event separately when the joined text is not JSON. That is more code than it is probably worth.

**2. The provider's `request.signal` is now aborted after every attempt, successful ones included.** `Effect.abortSignal` aborts when the scope closes, whatever the exit (`node_modules/effect/src/internal/effect.ts:4769`). The cleanup scope closes after every attempt (`execution/call.ts:254-258`). At the base, the signal passed to `provider.stream` was the execution's signal, and it fired only when a run was interrupted or ended. Now a custom provider or `createFetch` transport that listens for `abort` sees it after each completed response. A provider that reuses the request signal for work after the stream ends, instead of the signal `getResponseMetadata` receives, has that work cancelled. Exception 3 covers `return()`, not the signal. **Ran it:** `cleanup.ts` reports `Success hi signal: aborted` for a normal response. In-repo providers are not affected: OpenAI-compatible only aborts a body it has already fully read. *Smallest fix:* abort only on a failed or interrupted exit, using `Effect.acquireRelease(sync(() => new AbortController()), (c, exit) => Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => c.abort()))`. Or record it as a fourth exception.

## What I checked and found sound

- **Retry budget:** `upTo({ times: retries })` continues while `attempt <= retries` (`Schedule.ts:1687`). That gives `retries + 1` requests, the same as the base `attempt > retries` check.
- **Backoff:** `exponential(500)` gives `500·2^(attempt-1)` for the failed attempt (`Schedule.ts:1065`), the same as the base `backoff()`. `retryAfter` is in seconds, capped at 60, and `ResponseRejected` waits 0.
- **Attempt number:** `Effect.retry` provides `CurrentMetadata` with `attempt = 0` on the first run and the step's count after that (`internal/schedule.ts:65-73`). The trace text and `log.attempt` share one value.
- **What is retried:** `Effect.retry` retries only recoverable failures (`findRecoverableError`). Defects and interrupts escape as at the base. `SetupError` stops `Schedule.while` and is excluded from the stop catch, as at the base.
- **Stop:** a stop is checked before the request, after `record`, at the retry decision, and in the final catch, which matches every base return point. A stop does not interrupt a streaming attempt. A cut-off attempt after a stop returns `undefined` without a retry. Waking during the wait is exception 1.
- **Abort and interruption:** before headers, between chunks, after the finish chunk, and during the wait, interruption propagates as at the base. `tapError` does not run on an interrupt, so the calls are not abandoned, as at the base. The new scoped signal also aborts the transport sooner.
- **The stop latch:** an interrupted `Latch.await` removes its waiter (`internal/effect.ts:5998-6010`), so the waits leak nothing.
- **Detached cleanup:** I ran `return()` four ways: sync value, sync throw, reject, never settles. In every case the attempt succeeded, nothing was logged, there was no `unhandledRejection` or `uncaughtException`, and the process exited by itself. Scope finalizers keep running after one dies (`internal/effect.ts:4089-4111`). The cleanup touches only the provider's iterator and its own controller, not runtime state.
- **Two live iterators:** possible, as at the base, where `return()` was fire-and-forget and nothing was aborted. A held connection is no worse than at the base.
- **Secrets:** redaction is still done once, in `step.ts:126-165`, on `modelCalls` errors, the end error, and trace text. The schedule returns the same last `ProviderFailure`, and no new path logs a failure.
- **Blank line fed at the end:** a cut-off in the middle of a multi-byte character, in a JSON string, in a field name, or after `data: ` gives the same output as the base (ran it). The decoder flush emits U+FFFD in both.
- **S22 on virtual timers:** S22 asserts no timing, so faking `setTimeout` weakens nothing it proves. `onTestFinished` restores real timers. Each session's runtime, including the `ThreadSupervisor` poll, is disposed in `using`'s `finally`, so no fake timer outlives the test.

## Points of structure

- The stop rule is checked in four places (two in `requestOnce`, `Schedule.while`, `catchIf`). One check at the retry boundary plus the entry check would read more simply.
- `modifyDelay` does the wait itself and returns 0, which hides a side effect in what reads as a pure delay function.
- The transport abort is ordered after an idle iterator's `return()` in one sequential scope, so a `return()` that stalls means the abort never fires. Not worse than the base, but the order is load-bearing and implicit.

**Not judged in the time:** Bun's behavior for `AbortSignal.any` and Vitest fake timers (I ran Node only), and how common single-LF framing is among real servers. I did not rerun the suite or the comparison.

No commits, pushes, or comments. Both probes ran under `timeout`, and no probe processes remain.
