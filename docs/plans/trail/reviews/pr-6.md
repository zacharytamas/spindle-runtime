# Code quality review: PR 6 (`m1/4-step-loop`)

Reviewed PR 6 (`8aaf3ef..2eb5f77`) against the top of the stack `origin/m1/7-chat` (`43a4d5b`), focusing on the modules PR 6 still owns at tip: `packages/runtime/src/providers/` (`openai-compatible.ts`, `config.ts`, `script.ts`, `timeout.ts`), `packages/runtime/src/execution/` (`call.ts`, `assemble.ts`, `redact.ts`, `stop-rules.ts`, `env.ts`, `trace.ts`, `turn.ts`, `trigger.ts`), `packages/runtime/src/cli/run.ts`, and `packages/conformance/src/scenarios/step-loop.ts`.

`step.ts`, `tools.ts`, and `thread-state.ts` were largely rewritten by PR 7 (`m1/5-hooks`) and PR 8 (`m1/6-queue`), and `redactText` in `redact.ts` was deleted in PR 7; their detail is left to those reviewers.

---

## 1. Verdict

This PR does **not** pass the approval bar. The runtime behavior is well-audited and several small modules (`stop-rules.ts`, `redact.ts`, `timeout.ts`, `trace.ts`) are crisp, but PR 6 violates three presumptive blockers: it introduces a 3,115-line conformance file (`packages/conformance/src/scenarios/step-loop.ts`) that doubles as the shared harness for the whole conformance package, it hand-rolls core streaming, SSE parsing, and retry/backoff machinery in `execution/call.ts` and `providers/openai-compatible.ts` where Effect v4 already ships the primitives, and it threads per-step history assembly (`assemble.ts`) and CLI setup (`cli/run.ts`) in shapes that re-parse the entire thread history on every step and forced PR 8 and PR 10 to copy-paste the CLI harness. The single largest thing wrong is the **conflated 3,115-line `step-loop.ts` + hand-rolled execution/CLI plumbing** (`call.ts` retry/stream loops, `assemble.ts` full-history reparsing, `cli/run.ts` print-and-throw error handling), all of which have direct structural replacements that delete hundreds of lines without changing behavior.

---

## 2. Structural findings

### S1. `step-loop.ts` is 3,115 lines, owns the shared conformance harness for six other files, and repeats session setup 68+ times

- **Location:** `packages/conformance/src/scenarios/step-loop.ts:1-3115`
- **Maintainer cost:** At more than 3× the 1,000-line ceiling, 49 scenarios across six unrelated subsystems (turn assembly, retries, tool execution, stop rules, secrets/redaction, `ThreadState`) live in one file alongside the shared harness (`Scenario`, `Setup`, `project`, `open`, `using`, `gate`, `ok`, `callsOf`, `holding`, `history`, `sideOf`, `send`, lines 25-166) that all six other scenario files (`hooks.ts`, `integrity.ts`, `messages.ts`, `ownership.ts`, `queue.ts`, `run-status.ts`) import from `./step-loop.ts`. Finding or editing a scenario requires scrolling thousands of lines of copy-pasted `new ScriptedProvider` + `await using(...)` boilerplate.
- **Proposed restructuring:**
  1. Extract the shared harness (`lines 25-166` plus `shape` and `counter`) into `packages/conformance/src/scenarios/harness.ts` and add three helpers that eliminate the bulk of repeated scenario boilerplate:
     ```ts
     // packages/conformance/src/scenarios/harness.ts
     export interface RunOnceOptions extends Omit<Setup, "provider"> {
       readonly message?: string
       readonly env?: Record<string, string>
       readonly seed?: ReadonlyArray<SeedMessage>
       readonly sendOptions?: SendOptions
     }

     // Replaces ~35 of the 68 `new ScriptedProvider(...)` + `await using(...)` blocks that
     // send one turn and inspect outcome, stored messages, tool results, and requests.
     export const runOnce = async (
       driver: RuntimeDriver,
       steps: ReadonlyArray<ScriptStep>,
       options: RunOnceOptions = {},
     ) => {
       const provider = new ScriptedProvider(steps)
       const { message = "go", env, seed, sendOptions, ...setup } = options
       let outcome!: RunOutcome
       let messages: ReadonlyArray<Message> = []
       await using(driver, { ...setup, provider }, async (session, thread) => {
         if (seed !== undefined) await session.seed(thread, seed)
         outcome = await send(session, thread, message, sendOptions)
         messages = await session.messages(thread)
       }, env)
       return { outcome, messages, requests: provider.requests, tools: toolResults(messages), toolsById: toolResultById(messages) }
     }

     // Replaces 16+ repetitions of `.filter((m) => m.role === "tool")` and `Object.fromEntries(...)`
     export const toolResults = (messages: ReadonlyArray<Message>) => messages.filter((m) => m.role === "tool")
     export const toolResultById = (messages: ReadonlyArray<Message>) =>
       Object.fromEntries(toolResults(messages).map((m) => [m.tool_call_id, m]))

     // Replaces duplicated `chart` / `notes` fixtures (S15 L1267-1285, S24 L1845-1863) and
     // repeated single-line `defineTool({ description: ..., execute: async () => ok(...) })`
     export const stubTool = (result: string, description = "Stub") =>
       defineTool({ description, execute: async () => ok(result) })
     ```
  2. Split the 49 scenarios into six focused modules under `packages/conformance/src/scenarios/step-loop/`, keeping every file well under 600 lines:
     - `step-loop/turn-and-assembly.ts` (~470 lines): `S01`, `S02a`, `S02b` (+ `orientation`), `S03`, `S04`, `S05`, `S06a`, `S06b`, `S24`, `S35`
     - `step-loop/streaming-and-retries.ts` (~430 lines): `S07`, `S08`, `S09`, `S10`, `S11`, `S21`, `S22`, `S27`, `S36`
     - `step-loop/tools-and-results.ts` (~440 lines): `S12`, `S13`, `S14`, `S14b`, `S15`, `S16`, `S23`
     - `step-loop/stop-rules.ts` (~220 lines): `S17`, `S18`, `S18b`, `S18c`, `S19`, `S20`
     - `step-loop/secrets-and-redaction.ts` (~520 lines): `S26`, `S26b`–`S26i` (also deduplicating `declaresSecret` shared by `S26` and `S26d`)
     - `step-loop/thread-state.ts` (~460 lines): `S28`, `S29`, `S30`, `S31`, `S32`, `S32b`, `S33`, `S33b`, `S34`
  3. Keep `packages/conformance/src/scenarios/step-loop.ts` as a ~20-line barrel that exports `stepLoopScenarios` (concatenating the six arrays) and re-exports `harness.ts` during the transition (or update the six sibling scenario files to import from `./harness.ts`).
- **Estimated lines:** Removes ~350–450 net lines of repeated setup/assertions and reduces the largest file from 3,115 lines to ~520 lines.
- **Risk & tests:** Very low. `packages/conformance/ledger.json` and `packages/conformance/src/ledger.ts` match scenario names, not file paths (verified `grep -c 'step-loop' ledger.json` = 0). `packages/runtime/test/conformance.test.ts` imports `stepLoopScenarios` unchanged.
- **PR & ripple:** Carry in **PR 6**. If `step-loop.ts` re-exports `harness.ts`, ripple to PR 7/8/10 is limited to PR 7 moving its added `S26i` (and minor `S14b`/`S18b`/`S18c` edits) into the matching split files; if sibling scenario files switch to `./harness.ts`, that is a one-line import change in PR 7 (`hooks.ts`, `messages.ts`, `integrity.ts`) and PR 8 (`queue.ts`, `ownership.ts`, `run-status.ts`).
- **Effect APIs verified:** None required (pure Vitest/TS conformance package).

---

### S2. `assemble.ts` re-parses `tool_calls` JSON and scans the entire thread history on every step, making per-step cost grow with thread length

- **Location:** `packages/runtime/src/execution/assemble.ts:185-286` (specifically `L218`, `L240-244`, `L282-284`)
- **Maintainer cost:** On every single model step, `toProviderMessages` calls `toolCallsOf(message)` (which calls `JSON.parse` on `message.tool_calls` and again on every call's `function.arguments`) for every `user` and `assistant` row in the entire thread history, then runs `requestOrder` across all rows — even when `includeChat` and `includePastTools` are both `false` (the default) and every row in `view.past` is immediately discarded. In addition, when `requestOrder` does reorder, line 218 does `results.set(at, [...(results.get(at) ?? []), index])`, copying the array on every tool result (`O(k²)` per group). Appendix A (`docs/plans/m1-core-loop.md:782, 857`) already observed this linear growth in CPU profiles on 5,000-message threads.
- **Proposed restructuring:**
  1. When `!view.includeChat && !view.includePastTools`, filter `history` down to `const eligible = history.filter((m) => !view.past.has(m.id))` before parsing `tool_calls` and before running `requestOrder`. Checked against `toProviderMessages` (`L245-280`): when both flags are `false`, every `system`, `other`, and `own` row in `view.past` is dropped, and any `tool` row whose holder is in `view.past` is dropped because `showCalls` is `false`; synthetic messages inserted anywhere by `filter_messages` are not in `view.past` and survive unchanged.
  2. Memoize parsed tool calls per immutable `Message` object in a module-private `WeakMap<Message, ReadonlyArray<ProviderToolCallPart>>` (mirroring `positions` in `ThreadStore.ts`), or lazily parse only for rows whose calls can actually be shown or referenced. Because `history.ts` caches `Message` objects across steps by revision, `includeChat`/`includePastTools` threads stop re-parsing historical `tool_calls` JSON on every step (`O(steps × N)` → `O(N)`).
  3. In `requestOrder` (`L218`), mutate the local bucket (`let list = results.get(at); if (!list) { list = []; results.set(at, list) } list.push(index)`) instead of spreading on every element.
- **Estimated lines:** Net +5 to +10 lines; eliminates `O(steps × thread_length)` JSON parsing on every step.
- **Risk & tests:** Low. Guarded by `S02a`, `S02b`, `S04`, `S09`, `S30`, `I10` (request ordering), `M3`–`M8d`, and `packages/runtime/scripts/step-probe.ts run --seed 5000 --steps 50`. Note: because `toolCallsOf` is exported and returns a fresh array today (`L124`), any `WeakMap` cache should stay internal to `toProviderMessages` (returning `ReadonlyArray` internally) so external callers cannot mutate cached arrays.
- **PR & ripple:** Carry items 1–2 in **PR 6** (`assemble.ts`), item 3 in **PR 7** (where `requestOrder` was introduced). Ripples cleanly through PR 7's additions to `assemble.ts`.
- **Effect APIs verified:** None required.

---

### S3. `execution/call.ts` hand-rolls async-iterator streaming, manual cleanup, and an imperative retry/backoff loop instead of `Stream` and `Effect.retry` + `Schedule`

- **Location:** `packages/runtime/src/execution/call.ts:262-318` (`streamResponse`), `355-356` (`backoff`), `389-441` (`callModel`)
- **Maintainer cost:** `streamResponse` manually pulls `iterable[Symbol.asyncIterator]()` inside a `while (true)` + `Effect.tryPromise(() => iterator.next())` loop and manually registers `Effect.onError(() => Effect.sync(() => { Promise.resolve(iterator.return?.()).catch(() => {}) }))` (which does not await `return()` even when the iterator is idle). `callModel` then hand-rolls a `for (let attempt = 1; ; attempt++)` loop with `Effect.result`, manual `attempt > context.retries` bounds, and manual `Effect.sleep(backoff(failure, attempt))` arithmetic, obscuring the retry policy inside 52 lines of stateful control flow.
- **Proposed restructuring:**
  1. Replace the manual iterator loop in `streamResponse` with `Stream.fromAsyncIterable` + `Stream.runForEach`:
     ```ts
     yield* Stream.fromAsyncIterable(iterable, (cause) => failureOf(cause, provider)).pipe(
       Stream.runForEach((chunk) =>
         Effect.gen(function* () {
           const failure = applyChunk(response, chunk)
           if (failure !== undefined) return yield* failure
           if (hooks !== undefined) yield* startCalls(response, chunk, hooks, started, watchers)
         }),
       ),
     )
     ```
     `Stream.fromAsyncIterable` (backed by `Channel.fromAsyncIterable`) automatically registers a `Scope` finalizer that calls `iter.return()` on failure, interruption, or early stop — awaiting it when idle and firing-and-forgetting only when a `next()` pull is still pending.
  2. Replace the `for (let attempt = 1; ; attempt++)` loop and `backoff()` in `callModel` with `Effect.retry` + a declarative `Schedule`:
     ```ts
     let attempts = 0
     const attemptOnce = Effect.gen(function* () {
       if (context.stopped()) return undefined
       const attempt = ++attempts
       const provider = yield* context.provider
       yield* context.record(`${provider.name} ${request.model} attempt ${attempt}`)
       if (context.stopped()) return undefined
       const log: ModelCall = { step: context.step, attempt, model: request.model }
       context.calls.push(log)
       const started: Array<StreamedCall> = []
       const abandon = () =>
         started.length === 0 || context.streamed === undefined ? Effect.void : context.streamed.abandoned(started)
       const response = yield* streamResponse(provider, request, context.streamed, started).pipe(
         Effect.tapError((failure) =>
           Effect.andThen(abandon(), Effect.sync(() => { log.error = errorSummaryOf(failure) })),
         ),
       )
       recordSuccess(log, response)
       context.pending.push(yield* Effect.forkChild(fetchMetadata(provider, summaryOf(request.model, response), log)))
       const rejected = violation(response, context.toolChoice)
       if (rejected === undefined) return response
       log.rejected = rejected
       yield* abandon()
       return yield* new ResponseRejected({ message: rejected })
     }).pipe(
       Effect.catchIf(
         (error): error is ProviderFailure | ResponseRejected => error._tag !== "SetupError" && context.stopped(),
         () => Effect.succeed(undefined),
       ),
     )

     const retryPolicy = Schedule.exponential("500 millis").pipe(
       Schedule.upTo({ times: context.retries }),
       Schedule.while(({ input }: Schedule.Metadata<Duration.Duration, ProviderFailure | ResponseRejected | SetupError>) =>
         !context.stopped() && (input._tag === "ResponseRejected" || (input._tag === "ProviderFailure" && input.retryable)),
       ),
       Schedule.modifyDelay(({ input, duration }) =>
         Effect.succeed(
           input._tag === "ProviderFailure" && input.retryAfter !== undefined
             ? Duration.seconds(Math.min(input.retryAfter, 60))
             : input._tag === "ResponseRejected"
               ? Duration.zero
               : duration,
         ),
       ),
     )

     return yield* attemptOnce.pipe(
       Effect.retry(retryPolicy),
       Effect.mapError((error) =>
         error._tag === "ResponseRejected"
           ? new ResponseRejected({ message: `${error.message} after ${attempts} requests` })
           : error,
       ),
     )
     ```
- **Estimated lines:** Removes ~30–40 lines and deletes `backoff()`, `Result` import, manual iterator cleanup, and loop control flags.
- **Risk & tests:** Low. Guarded by `S07`, `S08`, `S09`, `S11`, `S21`, `S22`, `S36`, `H12d`, and `packages/runtime/test/cli/run.test.ts` (cut-off stream and body-timeout retry tests).
- **PR & ripple:** Carry in **PR 6**. Ripples cleanly into PR 7 (which only adds `startCalls`/`abandoned` hooks to `streamResponse`/`callModel`).
- **Effect APIs verified:** Verified in `effect@4.1.5` under `node_modules/effect/dist/`:
  - `Stream.fromAsyncIterable` / `Stream.runForEach` (`Stream.d.ts:1159`, `Channel.js` `fromAsyncIterable`) — verified live that `iter.return()` runs and awaits when idle.
  - `Schedule.exponential("500 millis")` computes `500 * 2 ** (attempt - 1)` (`Schedule.js` `exponential`), matching `call.ts:356` exactly.
  - `Schedule.upTo({ times: context.retries })` enforces `attempt <= times`, including `times: 0` → 1 attempt total (`Schedule.js` `upTo`).
  - `Schedule.while` and `Schedule.modifyDelay` (`Schedule.d.ts:909, 1304`) — verified live in scratch copy with `TestClock`, including that `Duration.zero` completes immediately without `TestClock.adjust`.

---

### S4. `providers/openai-compatible.ts` hand-rolls an incomplete SSE line parser where `effect/encoding/Sse.makeParser` exists — while `HttpClient` should *not* replace `post()`

- **Location:** `packages/runtime/src/providers/openai-compatible.ts:290-305` (`serverSentEvents`), `453-474` (`post`)
- **Maintainer cost:** `serverSentEvents` (`L290-305`) manually decodes bytes, slices `buffer = buffer.slice(end + 1)` on every newline (`O(n²)` on large chunks), yields every `data:` line independently (breaking multi-line `data:` SSE payloads), ignores UTF-8 BOM and bare `\r` separators, and has no event-size cap (unbounded memory growth on a malformed stream with no newline). Meanwhile, `streamChunks` (`L316-399`) and `responseOf` (`L412-442`) duplicate tool-call argument parsing, reasoning extraction, and detail assembly.
- **Proposed restructuring:**
  1. Replace `serverSentEvents` (`L290-305`) with `Sse.makeParser` from `effect/encoding/Sse`:
     ```ts
     import * as Sse from "effect/encoding/Sse"

     async function* serverSentEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
       const decoder = new TextDecoder()
       const queue: Array<string> = []
       const parser = Sse.makeParser((event) => {
         if (event._tag === "Event") queue.push(event.data)
       })
       const feed = (text: string) => {
         const error = parser.feed(text)
         if (error !== undefined)
           throw new ProviderError(error.message, "server_error", undefined, undefined, { origin: ORIGIN })
       }
       for await (const bytes of body) {
         feed(decoder.decode(bytes, { stream: true }))
         while (queue.length > 0) yield queue.shift()!
       }
       feed(decoder.decode())
       // Flush any final data: line if the server closed without a trailing blank line.
       feed("\n\n")
       while (queue.length > 0) yield queue.shift()!
     }
     ```
     This stays pure Promise/`AsyncGenerator` (zero Effect runtime overhead at the public provider boundary), fixes BOM/CRLF/multi-line `data:`/`O(n²)` slicing, and gains Effect's 10 MiB `maxEventSize` guard.
  2. **Explicit verdict on `effect/http` `HttpClient` for `post()` (`L453-474`) and `codeForStatus`/`retryAfterSeconds` (`L171-217`):** **Do NOT replace `post()` with `FetchHttpClient`/`HttpClient`.** Verified against `node_modules/effect/dist/http/`:
     - `openaiCompatible` is a public Promise/`AsyncIterable` factory (`packages/runtime/src/index.ts:1`) implementing `@standardagents/spec`'s `ProviderFactoryWithOptions`, which takes a plain `FetchLike` and runs with no Effect runtime in external callers and unit tests.
     - `HttpClient.timeout` (`HttpClient.js`) wraps only `client.execute` (headers arrival), whereas `openai-compatible.ts` must apply one `AbortSignal.timeout(config.timeout)` across headers, error-body reads (`openai-compatible.test.ts:172`), and streaming reads (`openai-compatible.test.ts:148`).
     - `HttpClientError` (`HttpClientError.d.ts`) classifies by transport/status/decode rather than `@standardagents/spec`'s `ProviderErrorCode`, and `HttpClient.js`'s `withRetryAfter` helper is unexported. Bridging `FetchHttpClient` back to `Promise`/`AsyncIterable` via `Effect.runPromise` + `Scope` + `Stream.toAsyncIterable` would add ~40+ lines and lifecycle hazards while still keeping `codeForStatus`, `retryAfterSeconds`, and `isTimeout`.
- **Estimated lines:** Net ~+2 lines in `serverSentEvents` (deleting manual buffer/line-splitting logic in favor of WHATWG-compliant, bounded `Sse.makeParser`); explicitly avoids a net-negative `HttpClient` rewrite.
- **Risk & tests:** Low. Guarded by `packages/runtime/test/providers/openai-compatible.test.ts` (lines 108-448) and `packages/runtime/test/cli/run.test.ts` (lines 217-250, 334-436). Note: `Sse.makeParser` strips at most one leading space after `data:` (WHATWG spec), which is identical for JSON payloads.
- **PR & ripple:** Carry in **PR 6**. Zero ripple — no later PR modifies `openai-compatible.ts`.
- **Effect APIs verified:** Verified `Sse.makeParser` in `node_modules/effect/dist/encoding/Sse.d.ts:166` and `Sse.js:149-275`, and ran it live on multi-line, CRLF, `[DONE]`, and `retry:` streams in scratch copy. Verified `HttpClient.timeout`, `HttpClient.retryTransient`, `HttpClientError`, and `FetchHttpClient` in `node_modules/effect/dist/http/`.

---

### S5. `cli/run.ts` prints errors inside throw helpers, duplicates its CLI setup in `cli/chat.ts`, opens SQLite twice for `spindle send`, and omits `secrets` on `createThread`

- **Location:** `packages/runtime/src/cli/run.ts:25-55, 90-109, 146-248` (and duplicated in `packages/runtime/src/cli/chat.ts:75-86, 327-413`, `packages/runtime/src/cli/status.ts:35-41`)
- **Maintainer cost:** Four problems compound in `cli/run.ts`:
  1. **Side-effectful error constructors:** `fail(msg)` (`L25-29`) prints to `Console.error` and fails with `RunFailed`, `reject(msg)` (`L198`) prints to unredacted `identify` and fails with `RunFailed`, `openDatabase` (`L103-106`) builds `Layer.effect(ThreadStore, problem(...))` solely to print, and then `catchCause` (`L232-241`) has to check `instanceof RunFailed` to avoid double-printing while handling `ThreadTerminated` and unknown errors separately. `chat.ts` and `status.ts` copy-paste that same `catchCause` dance.
  2. **Duplicated CLI harness:** `cli/chat.ts` copy-pastes `loadScript` (as `readScript`), redacting console/logger setup, `prepareTurn` + `learnSecrets`, `validate` + error printing, and `catchCause` verbatim from `cli/run.ts`.
  3. **Double DB open on `spindle send` (`L167-178, 229`):** For `send`, `deliver` provides `opened` once to read `thread.agentId` (opening SQLite, running migrations, closing it when the scoped provide finishes), then provides `database` a second time at `L229` — and types `store` at `L165` as `Layer.Layer<ThreadStore, unknown>`, poisoning the entire `deliver` error channel with `unknown`.
  4. **Missed `secrets` handoff on `createThread` (`L206`):** `createThread(target.agent)` omits `secrets` (unlike `chat.ts:104`, which passes `createThread(agent, secrets)`), so any secret an `after_thread_created` hook reads via `state.env()` is invisible to `run.ts`'s redacting console (`docs/design/secrets.md` Gap 4).
  5. Minor sprawl: `L161-162` loops over a 1-element constant tuple `[["--hook-timeout", args.hookTimeout]]`, and `deliver` nests three `Effect.gen` blocks (`L157`, `L179`, `L205`).
- **Proposed restructuring:**
  Extract a small `packages/runtime/src/cli/shared.ts` module owning the CLI boundary once:
  ```ts
  // Typed CLI errors — never print at throw sites.
  export class CliError extends Data.TaggedError("CliError")<{
    readonly message: string
    readonly raw?: boolean // true for operatorNotes (thread IDs, already-redacted summaries)
  }> {}

  export class ReportedExit extends Data.TaggedError("ReportedExit")<{ readonly message: string }> {
    override readonly [Runtime.errorReported] = false
  }

  // One wrapper for run, send, chat, status: installs redacting Console + Logger,
  // prints CliError / ThreadTerminated / unexpected causes ONCE, converts to ReportedExit.
  export const withCliEnvironment = (
    options: { readonly escapeControls?: boolean },
    body: (env: { readonly secrets: Set<string>; readonly redact: (s: string) => string; readonly identify: (s: string) => Effect.Effect<void> }) => Effect.Effect<void, CliError | ThreadTerminated | ..., ...>
  ) => ...

  export const loadScript = (file: string): Effect.Effect<LLMProviderInterface, CliError, FileSystem.FileSystem> => ...
  export const validateProject = (root: string, agent: string, secrets: Set<string>) => ...
  export const openDatabase = (filename: string): Effect.Effect<Layer.Layer<ThreadStore, CliError>, CliError, FileSystem.FileSystem | Path.Path> => ...
  ```
  In `deliver`, open the database once in a `Scope` (or keep `store` typed `Layer.Layer<ThreadStore, CliError>` and use `Layer.memoize(opened)` inside `Effect.scoped` so `send` does not open SQLite twice) and pass `secrets` to `createThread(target.agent, secrets)`.
- **Estimated lines:** Removes ~90–120 lines across `run.ts`, `chat.ts`, and `status.ts`, eliminates 8 `TS377030` diagnostics in `run.ts`, and fixes the `createThread` secret gap and double-open bug.
- **Risk & tests:** Medium (touches CLI output formatting and exit paths). Guarded by `packages/runtime/test/cli/run.test.ts` (all 15 tests), `test/cli/chat.test.ts`, `test/cli/queue.test.ts`, and `test/cli/ownership.test.ts`.
- **PR & ripple:** Start the clean `CliError` + `withCliEnvironment` + `loadScript` + `openDatabase` boundary in **PR 6**; PR 8 reuses `Layer.memoize` for `send` and `status.ts`; PR 10 deletes the duplicated `readScript`, validation loop, console/logger wrapper, and `catchCause` in `chat.ts`.
- **Effect APIs verified:** Verified `Layer.memoize` (`node_modules/effect/dist/Layer.d.ts`), `Runtime.errorReported`, `Console.consoleWith`, `Logger.layer` in `effect@4.1.5`.

---

### S6. `providers/script.ts` casts raw JSON `chunks` to `ProviderStreamChunk[]` and duplicates error-code validation

- **Location:** `packages/runtime/src/providers/script.ts:20-29, 41-59, 77`, `packages/runtime/src/execution/call.ts:15-26`
- **Maintainer cost:** `script.ts:20` decodes `chunks` as `Schema.Array(Schema.Record(Schema.String, Schema.Unknown))` and then line 77 performs an unchecked cast `response.chunks as ReadonlyArray<ProviderStreamChunk>`. A typo in a `--script` file (e.g., `type: "content_delta"` or missing `finishReason`) passes `decodeScript` and fails cryptically inside the loop. Separately, the 6-value `ProviderErrorCode` literal union is defined three times (`script.ts:25`, `script.ts:41-48` with `code as ProviderErrorCode`, and `call.ts:15-25` with `value as ProviderErrorCode`).
- **Proposed restructuring:**
  1. Define `export const ProviderErrorCodeSchema = Schema.Literals(["rate_limit", "invalid_request", "auth_error", "server_error", "timeout", "unknown"])` in one place (e.g., `providers/timeout.ts` renamed `providers/errors.ts`, or `execution/call.ts`) and use `Schema.is(ProviderErrorCodeSchema)` in both `script.ts` and `call.ts`, deleting both `CODES` arrays and both `as ProviderErrorCode` casts.
  2. Replace `Schema.Record(Schema.String, Schema.Unknown)` on `script.ts:20` with a `Schema.Union` of the `ProviderStreamChunk` variants (`content-delta`, `reasoning-delta`, `tool-call-start`, `tool-call-delta`, `tool-call-done`, `finish`, `error`, etc.), deleting the `as ReadonlyArray<ProviderStreamChunk>` cast at `L77`.
- **Estimated lines:** Net ~+15 lines for the chunk union schema, removing 2 duplicate `CODES` lists and 3 unsafe `as` casts while giving `--script` real decode-time validation.
- **Risk & tests:** Low. Guarded by `packages/runtime/test/providers/script.test.ts` and every `--script` test in `packages/runtime/test/cli/run.test.ts`.
- **PR & ripple:** Carry in **PR 6**. Zero ripple upward.
- **Effect APIs verified:** `Schema.Literals`, `Schema.Union`, `Schema.is` verified in `node_modules/effect/dist/Schema.d.ts` (already used across the repo).

---

### S7. `assemble.ts:fromLLMMessage` relies on 11 unchecked `as` casts backed by distant validation in `hooks.ts` (shotgun parsing)

- **Location:** `packages/runtime/src/execution/assemble.ts:328-368` (added in PR 7, sitting in PR 6's `assemble.ts` at tip)
- **Maintainer cost:** `fromLLMMessage` and `callFrom` contain 11 `as` casts and an unguarded `JSON.parse(fn.arguments)` because validation happens separately in `hooks.ts` (`acceptProviderMessages` / shape checks) returning a loosely-typed `LLMMessage[]`. Any future change to `ProviderMessage` or `LLMMessage` must keep two distant files in lockstep without compiler enforcement.
- **Proposed restructuring:** Replace the split validate-in-`hooks.ts` + cast-in-`assemble.ts` pair with one `Schema` codec from `LLMMessage` to `ProviderMessage` (or one parse-don't-validate function returning `Result<ProviderMessage, string>`) that validates and transforms in a single pass.
- **Estimated lines:** Removes ~40–60 lines across `hooks.ts` and `assemble.ts` and eliminates all 11 casts in `fromLLMMessage`/`callFrom`.
- **Risk & tests:** Low–medium (error messages for invalid `prefilter_llm_history` returns must stay clear). Guarded by `H11`, `H11b`, and `packages/conformance/src/scenarios/hooks.ts`.
- **PR & ripple:** Carry in **PR 7** (`m1/5-hooks`), which introduced `fromLLMMessage` and `hooks.ts`. No ripple to PR 8/10.
- **Effect APIs verified:** `Schema.Struct`, `Schema.Union`, `Schema.decodeUnknownResult` in `node_modules/effect/dist/Schema.d.ts`.

---

## 3. Effect practice findings

Confirmed `@effect/tsgo` diagnostics on PR 6's files at `origin/m1/7-chat` (`43a4d5b`), run in a scratch copy with both default rules and expanded Effect rules enabled (excluding `unstableApiUsage` per brief and `preferSchemaTaggedError` `TS377139`, which is a repo-wide convention choice where all 7 PRs intentionally use `Data.TaggedError` for internal non-serialized errors).

### E1. `providerFor` returns a nested `Effect<Effect<...>>` (`effect(returnEffectInGen)`, `TS377014`)

- **Location:** `packages/runtime/src/providers/config.ts:130, 132` (callers: `packages/runtime/src/execution/step.ts:423-426`, `packages/runtime/test/providers/openai-compatible.test.ts:480, 562-565, 594`)
- **Maintainer cost:** Returning an `Effect` directly from `Effect.fn` yields `Effect<Effect<LLMProviderInterface, SetupError>, SetupError, Fetch>`, forcing callers and tests to write `yield* yield* providerFor(...)` and triggering `TS377014` (`returnEffectInGen`) on both return statements.
- **Proposed restructuring:** Have `providerFor` return a plain provider-accessor function `() => Effect.Effect<LLMProviderInterface, SetupError>` (or `{ readonly next: Effect.Effect<LLMProviderInterface, SetupError> }`):
  ```ts
  if (definition?.createFetch !== undefined) return () => build
  const instance = yield* build
  return () => Effect.succeed(instance)
  ```
  Update `CallContext.provider` to `() => Effect.Effect<LLMProviderInterface, SetupError>` and `step.ts:423` to `options.provider === undefined ? yield* providerFor(...) : () => Effect.succeed(options.provider)`. Behavior stays identical (`createFetch` still builds lazily per request, standard providers still build eagerly at setup).
- **Estimated lines:** Net 0 lines; removes nested `Effect<Effect<...>>` and both `TS377014` diagnostics.
- **Risk & tests:** Very low. Guarded by `packages/runtime/test/providers/openai-compatible.test.ts:450-625` and `S36`.
- **PR & ripple:** Carry in **PR 6**; touches `step.ts` (PR 6, rebased through PR 7/8) and `openai-compatible.test.ts`.
- **Effect APIs verified:** Verified with `@effect/tsgo` (`TS377014`).

---

### E2. `unknown` leaks into the Effect error channel (`effect(unknownInEffectCatch)` `TS377021` & `effect(anyUnknownInErrorContext)` `TS377030`)

- **Location:**
  - `packages/runtime/src/execution/call.ts:372` (`TS377021` + `TS377030`): `Effect.tryPromise({ try: ..., catch: (cause) => cause })` inside `fetchMetadata`
  - `packages/runtime/src/cli/run.ts:165, 197, 209, 229, 234, 239, 245, 293` (`TS377030`): `let store: Layer.Layer<ThreadStore, unknown> | undefined` widens the entire `deliver` error channel to `unknown`
  - `packages/runtime/src/execution/trigger.ts:74` (`TS377030`) & `packages/runtime/test/spindle-driver.ts:138, 156` (`TS377030`) & `packages/runtime/test/cli/run.test.ts:24` (`TS377030`): inherited from `ThreadSupervisor.send` / `deliver` having `unknown` in `E`.
- **Maintainer cost:** Once `unknown` enters `E`, TypeScript stops checking exhaustive `Effect.catchTag` handling and forces runtime `instanceof` checks (as seen in `cli/run.ts:234-238`). In `call.ts:372`, `catch: (cause) => cause` immediately turns `cause` into a string six lines later anyway.
- **Proposed restructuring:**
  1. In `call.ts:372`, map the error directly in `catch`: `catch: (cause) => new MetadataError({ message: cause instanceof Error ? cause.message : String(cause) })` (or `catch: (cause) => (cause instanceof Error ? cause.message : String(cause))` since `fetchMetadata` immediately handles it with `Effect.match` and returns `Effect<void>`).
  2. In `cli/run.ts:165`, type `store` with the actual `openDatabase` error (`Layer.Layer<ThreadStore, RunFailed>` or `CliError` under S5).
  3. In PR 8's `ThreadSupervisor`, narrow `send`'s error channel instead of `unknown` (resolving `trigger.ts:74` and `spindle-driver.ts:138, 156`).
- **Estimated lines:** Net ~0 lines; eliminates 13 `TS377021`/`TS377030` diagnostics across PR 6's files.
- **Risk & tests:** Very low. Guarded by `S11` (metadata fetch), `run.test.ts`, and `spindle-driver.ts`.
- **PR & ripple:** `call.ts:372` in **PR 6** (zero ripple); `run.ts:165` and `ThreadSupervisor` typing in **PR 8**.
- **Effect APIs verified:** Verified with `@effect/tsgo` (`TS377021`, `TS377030`).

---

### E3. `providers/script.ts` uses `Schema.Number` instead of `Schema.Finite` (`effect(schemaNumber)`, `TS377098`)

- **Location:** `packages/runtime/src/providers/script.ts:27-28`
- **Maintainer cost:** `Schema.Number` admits `NaN`, `Infinity`, and `-Infinity`. Because `Script` is exported and accepted by `scriptedProvider(script)`, using `Schema.Finite` (and `Schema.Int` for `statusCode`) makes the domain contract explicit and removes both default `@effect/tsgo` suggestions.
- **Proposed restructuring:** Change `statusCode: Schema.optionalKey(Schema.Number)` and `retryAfter: Schema.optionalKey(Schema.Number)` to `Schema.Finite` (or `Schema.Int` for `statusCode`, `Schema.Finite` for `retryAfter`).
- **Estimated lines:** Net 0 lines.
- **Risk & tests:** None. Guarded by `packages/runtime/test/providers/script.test.ts` and `run.test.ts`.
- **PR & ripple:** Carry in **PR 6**. Zero ripple.
- **Effect APIs verified:** Verified `Schema.Finite` / `Schema.Int` in `node_modules/effect/dist/Schema.d.ts` and with `@effect/tsgo` (`TS377098`).

---

### E4. `Secrets` is a raw mutable 3-`Set` bag threaded manually through six modules instead of a scoped service

- **Location:** `packages/runtime/src/execution/env.ts:24-39`, `packages/runtime/src/providers/config.ts:27-35, 76, 97`, `packages/runtime/src/execution/assemble.ts:40, 96, 105`, `packages/runtime/src/cli/run.ts:148, 184, 201, 206`
- **Maintainer cost:** Every layer that touches secrets (`resolveConfig`, `providerFor`, `learnSecrets`, `renderSystemPrompt`, `checkSystemPrompt`, `checkSystemMessages`, `createThread`, `sendMessage`, `ExecutionOptions`) takes `secrets: Secrets` or `secrets?: Set<string>` as a manual parameter and mutates its `.names`, `.values`, and `.barred` sets in place. Passing the wrong collection (or forgetting to pass it, as `cli/run.ts:206` did on `createThread`) silently creates a redaction blind spot (`docs/design/secrets.md` Gap 4).
- **Proposed restructuring:** Model `SecretRegistry` as a `Context.Service` (or `Context.Reference` defaulting to a fresh per-scope instance, or a small object created once per CLI/execution scope and provided via `Effect.provideService`) with explicit methods (`addSecret(value)`, `addValue(value)`, `markName(name)`, `hasName(name)`, `redact(text)`, `containsBarred(text)`). That removes `secrets` from function parameter lists across `config.ts`, `assemble.ts`, `step.ts`, and `trigger.ts`, and ensures `createThread` and `sendMessage` in `cli/run.ts` automatically share the same redaction set through Effect's context.
- **Estimated lines:** Removes ~25–35 lines of parameter threading and `newSecrets(options.secrets)` plumbing; eliminates the `run.ts:206` `createThread` omission by construction.
- **Risk & tests:** Medium — note `docs/design/secrets.md` records deliberate isolation between `atRest` handles outside a run and active executions, so each `runExecution` / CLI command must explicitly provide its own `SecretRegistry` service rather than sharing a process-wide default. Guarded by `S26`–`S26i`, `H22`, `H22b`, `I5`, and `packages/runtime/test/cli/run.test.ts:150-171, 217-332`.
- **PR & ripple:** Carry in **PR 6**; ripples into PR 7 (`messages.ts`, `trigger.ts`), PR 8 (`ThreadSupervisor`), and PR 10 (`chat.ts`).
- **Effect APIs verified:** Verified `Context.Service` / `Effect.provideService` in `node_modules/effect/dist/Context.d.ts` and `Effect.d.ts`.

---

### E5. `cli/run.ts` clones `Console` via `Object.create` prototype patching, and `answerInterrupts` forks via `Effect.runForkWith` + mutable boolean instead of `acquireRelease` + `Queue`

- **Location:** `packages/runtime/src/cli/run.ts:49-55` (`redacting`), `85` (`printer`, `TS377157`/`TS377026`), `252-281` (`answerInterrupts`, added in PR 8)
- **Maintainer cost:**
  1. `redacting` (`L49-55`) uses `Object.assign(Object.create(console) as Console.Console, { log, error })` — only wrapping `log` and `error` (leaving `warn`/`info`/`debug` unredacted) and casting `Object.create(...)` to `Console.Console`.
  2. `answerInterrupts` (`L252-281`) bridges Node's interrupt callback with raw `Effect.runForkWith(context)` + a mutable `let stopping = false` + `sender.interruptUnsafe(sender.id)` + `Effect.ensuring(() => remove())`. Meanwhile `cli/chat.ts:156-160` already shows the idiomatic Effect pattern (`Queue.make<void>()` + `Effect.acquireRelease` + `Queue.offerUnsafe`).
  3. At `L85`, `@effect/tsgo` flags `JSON.stringify(call.arguments)` with `globalJsonInEffect` (`TS377157`) / `preferSchemaOverJson` (`TS377026`). This is low-risk because `toolCallsOf` only produces parsed JSON objects, so it is informational rather than a blocker.
- **Proposed restructuring:**
  1. Build a small helper in `cli/shared.ts` that wraps `log`, `error`, `warn`, `info`, `debug` cleanly on `Console.Console` (spreading or delegating with a typed helper rather than `Object.create(...) as Console.Console`).
  2. In `answerInterrupts` (PR 8), register `onInterrupt` via `Effect.acquireRelease` pushing into a `Queue.make<void>()` and handle interrupts in a scoped forked fiber (or `Effect.scoped`), deleting the mutable `stopping` flag, `Effect.runForkWith(context)`, and `Effect.ensuring`.
- **Estimated lines:** Net ~0 lines; removes unsafe prototype casting and manual `runForkWith` lifecycle management.
- **Risk & tests:** Low. Guarded by `packages/runtime/test/cli/run.test.ts` and `packages/runtime/test/cli/queue.test.ts` / `ownership.test.ts`.
- **PR & ripple:** `redacting` in **PR 6** (ripples to `chat.ts` in PR 10); `answerInterrupts` in **PR 8** (zero ripple).
- **Effect APIs verified:** Verified `Effect.acquireRelease`, `Queue.make`, `Queue.offerUnsafe`, `Console.Console` in `effect@4.1.5` (and already used in `cli/chat.ts:156-160`).

---

### E6. Minor Effect-boundary hygiene in `providers/config.ts`, `execution/env.ts`, and `execution/assemble.ts`

- **Location:** `packages/runtime/src/providers/config.ts:115-129`, `packages/runtime/src/execution/env.ts:44-47`, `packages/runtime/src/execution/assemble.ts:52`
- **Maintainer cost:** Three small anti-patterns sit in PR 6's files:
  - `config.ts:122`: throws a raw `new Error("it did not return...")` inside `Effect.try` solely to catch it three lines later and turn it into `SetupError`, instead of `Effect.flatMap` + `Effect.fail(new SetupError(...))`.
  - `env.ts:44-47`: wraps a single `yield* Config.option(Config.String(name))` in `Effect.gen` instead of `Config.option(Config.String(name)).pipe(Effect.map(Option.getOrUndefined), Effect.orElseSucceed(() => undefined))`.
  - `assemble.ts:52`: uses an inline dynamic type import `import("../registry/Registry.ts").Registry` on `render`'s return type when `Registry` is already imported from `../registry/Registry.ts` on line 14.
- **Proposed restructuring:** Replace the throw-and-catch with `Effect.filterOrFail(isProvider, () => new SetupError(...))`, simplify `instanceEnv` to a pipeline, and import `Registry` cleanly on `assemble.ts:14`.
- **Estimated lines:** Removes ~6 lines.
- **Risk & tests:** None. Guarded by `openai-compatible.test.ts:606-624`, `S03`, `S32`, `S32b`.
- **PR & ripple:** Carry in **PR 6**. Zero ripple.
- **Effect APIs verified:** Verified `Effect.filterOrFail`, `Config.option`, `Config.String`, `Option.getOrUndefined` in `effect@4.1.5`.

---

### E7. Confirmed `@effect/tsgo` diagnostics in PR 6's test files (`provideLayerSucceedToProvideService`, `globalDateInEffect`, `newPromise`)

- **Location:**
  - `effect(provideLayerSucceedToProvideService)` (`TS377124`): `packages/runtime/test/cli/run.test.ts:346, 372, 410, 431` — `.pipe(Effect.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)))` should be `.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch))` (matching `openai-compatible.test.ts:484`).
  - `effect(globalDateInEffect)` (`TS377067`): `packages/runtime/test/cli/run.test.ts:91, 98` (added in PR 7) — uses `Date.now()` inside `it.live` instead of `Clock.currentTimeMillis`.
  - `effect(newPromise)` (`TS377080`): `packages/runtime/test/providers/openai-compatible.test.ts:139` — intentional inside a plain `async` mock `fetch` function (outside Effect); no change needed, listed for completeness.
- **Estimated lines:** Net 0 lines (4 one-line cleanups in `run.test.ts`).
- **Risk & tests:** None; test-only changes.
- **PR & ripple:** `run.test.ts:346, 372, 410, 431` in **PR 6**; `run.test.ts:91, 98` in **PR 7**.
- **Effect APIs verified:** Verified `Effect.provideService` and `Clock.currentTimeMillis` in `effect@4.1.5`, and confirmed all diagnostics directly with `@effect/tsgo`.

---

## 4. Duplication with code from other pull requests

- **`isRecord` is copy-pasted 13 times across `packages/runtime/src/`:** PR 6 introduces 5 copies (`providers/openai-compatible.ts:29`, `providers/config.ts:14`, `execution/call.ts:27`, `execution/assemble.ts:19`, `execution/turn.ts:53`, plus `tools.ts:27`, `thread-state.ts:86`), duplicating copies in PR 5 (`registry/validate.ts:64`, `registry/load-packages.ts:18`), PR 4 (`store/schema.ts:182`), PR 7 (`execution/hooks.ts:59`, `execution/messages.ts:47`), and PR 8 (`execution/ThreadSupervisor.ts:65`). Effect v4 already ships `Predicate.isObject` (`node_modules/effect/dist/Predicate.d.ts:1170`, verified to check `typeof input === "object" && input !== null && !Array.isArray(input)`).
- **`cli/run.ts` (PR 6) vs `cli/chat.ts` (PR 10) vs `cli/status.ts` (PR 8) vs `cli/validate.ts` (PR 5):** `loadScript`/`readScript`, project validation error printing, pre-learning turn secrets, redacting `Console` + `Logger.make`, top-level `Effect.catchCause` error handling, and `plural` (`run.ts:144` vs `validate.ts:17`) are copy-pasted across CLI commands.
- **`describe` error-to-string formatting:** Duplicated in `cli/run.ts:111`, `cli/chat.ts:43`, `cli/status.ts:40`, `execution/step.ts:238`, `execution/tools.ts:31`, `execution/call.ts:56, 379`, `providers/openai-compatible.ts:212`, and `providers/config.ts:127`.
- **`parseJson` safe wrapper:** Duplicated in `execution/assemble.ts:22` and `execution/step.ts:111` (and inline `try/catch` in `providers/openai-compatible.ts:190, 254`).
- **`noInvoke` stub:** Duplicated verbatim between `execution/trigger.ts:38-42` and `execution/step.ts:362-366` (both PR 7).
- **`providers/script.ts:101-126` vs `conformance/src/ScriptedProvider.ts:125-161`:** Same chunk-to-`ProviderResponse` fold, but **intentionally separate** per Appendix A (`docs/plans/m1-core-loop.md:736`) so `packages/conformance` imports nothing from `packages/runtime`. Do not merge across packages.

---

## 5. What is good and should not be touched

- **`packages/runtime/src/execution/stop-rules.ts` (37 lines) and `test/execution/stop-rules.test.ts`:** Data-driven ordered rule table (`STOP_RULES`) with zero Effect ceremony and complete pairwise precedence unit tests.
- **`packages/runtime/src/execution/redact.ts` (40 lines) and `test/execution/redact.test.ts`:** Clean, small, pure redactor and cycle-safe `mapStrings` walker; PR 7 already removed the over-engineered JSON-aware `redactText`.
- **`packages/runtime/src/providers/timeout.ts` (14 lines) and `execution/trace.ts` (12 lines):** Focused single-purpose helpers shared cleanly across layers.
- **`packages/runtime/src/providers/openai-compatible.ts:453-474` (`post`) and `171-217` (HTTP/transport error mapping):** Keeping `openaiCompatible` on plain `FetchLike` + `AbortSignal.timeout`/`AbortSignal.any` is the right call for a standalone `@standardagents/spec` provider whose timeout must span headers, error bodies, and streaming bodies.
- **`packages/runtime/src/providers/config.ts:110` (`FetchHttpClient.Fetch`) and `execution/env.ts:44` (`Config.option(Config.String(name))`):** Using Effect v4's built-in `Fetch` context reference and `ConfigProvider` makes transport and environment injection completely testable without monkey-patching globals.
- **`packages/runtime/src/execution/turn.ts` (185 lines):** Clear, well-bounded preflight module resolving sides, prompt, model, tools, and `stopTool` into a single immutable `Turn` value before the loop starts.

---

## 6. What could not be judged and why

- **`execution/step.ts`, `execution/tools.ts`, and `execution/thread-state.ts`:** Rewritten substantially by PR 7 (`m1/5-hooks`) and PR 8 (`m1/6-queue`); per the task brief, their internal structure (including `Run`'s mutable fields and `ThreadSupervisor` coordination) is left to those reviewers.
- **`execution/call.ts:143-260` (`argumentWatcher` and `startCalls`):** Added in PR 7 (`m1/5-hooks`) for streaming `tool_call_started` progress arguments; left to PR 7's reviewer.
- **`execution/trigger.ts:14-66` (`atRest`, `stateAtRest`, `createThread`):** Added in PR 7 (`m1/5-hooks`), while PR 6's original `sendMessage` was replaced by a 5-line wrapper around `ThreadSupervisor.send` in PR 8; left to PR 7 and PR 8's reviewers.
- **Runtime behavior on live LLM endpoints:** Not exercised; only static analysis, Effect v4 declaration/runtime verification in a scratch copy, and `@effect/tsgo` diagnostics were run.
