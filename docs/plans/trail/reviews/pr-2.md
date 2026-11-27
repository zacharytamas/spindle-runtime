# Code Quality Review: PR 2 (`m1/1-workspace`)

**PR:** `zacharytamas/spindle-runtime` PR 2, branch `m1/1-workspace` ("Workspace, platform modules, requirement ledger")
**Base:** `origin/plan/v1` (`c6323b5`) | **Head:** `origin/m1/1-workspace` (`5f0ecf3`) | **Verified at stack tip:** `origin/m1/7-chat` (`43a4d5b`)

---

## 1. Verdict

**Does not pass the approval bar without structural fixes.** PR 2's core workspace setup (Biome platform isolation, conditional `#platform` imports, Vitest dual-runtime configuration, and the schema-validated requirement ledger) is lean and well-motivated, and none of its files are bloated. However, the single largest problem is that the `#platform` abstraction and `cli/main.ts` entrypoint left weak contracts that later PRs immediately leaked through: `Platform.ts` only checks one-way subset assignability (so `processAlive` has already drifted out of `Platform` while `node.ts` and `bun.ts` duplicate five runtime-agnostic exports), `platform/interrupts.ts` exposes a module-level mutable array and raw JS callback instead of a scoped Effect service (producing an async `stopping` race and `Effect.runForkWith` boilerplate in `cli/run.ts` and manual `Queue`/`acquireRelease` bridging in `cli/chat.ts`), and `cli/main.ts` eagerly invokes `runMain` at module load with no shared CLI error contract (forcing tests to rebuild fake root commands and subcommands to copy-paste `Effect.catchCause` — which `recoverCommand` forgot).

---

## 2. Structural findings

### S1. `Platform.ts` checks only one-way assignability and duplicates 5 runtime-agnostic exports across `node.ts` and `bun.ts` (`processAlive` has already drifted)

- **Location at `origin/m1/7-chat`:** `packages/runtime/src/platform/Platform.ts:9-25`, `packages/runtime/src/platform/node.ts:5-22`, `packages/runtime/src/platform/bun.ts:5-21`.
- **Cost to maintainers:** `Implements<Module extends Platform>` only asserts that `node.ts` and `bun.ts` export *at least* the keys in `Platform`, not *the same* keys. Commit `833053d` (PR 8) already added `export { processAlive } from "./process-alive.ts"` to both files without adding it to `Platform.ts`; because `tsc` resolves `#platform` only to `node.ts`, any future export added to `node.ts` without updating `Platform.ts` and `bun.ts` passes `pnpm typecheck` and crashes on Bun at runtime. Meanwhile, 5 of the 8 exports (`openChatTerminal`, `onInterrupt`, `runMain`, `processId`, `processAlive`) and the `Layer.unwrap` lazy-SQLite loader are duplicated verbatim across `node.ts` and `bun.ts`.
- **Proposed restructuring:** Split runtime-agnostic helpers from the 3 genuinely runtime-specific bindings (`platformName`, `PlatformLive`, `SqliteLive`), and enforce exact mutual key equality in `Platform.ts`:
  ```ts
  // packages/runtime/src/platform/shared.ts
  import { Effect, Layer } from "effect"
  import type { SqlClient } from "effect/sql/SqlClient"
  import type { SqlError } from "effect/sql/SqlError"

  export { openChatTerminal } from "./chat-terminal.ts"
  export { onInterrupt, runMain } from "./interrupts.ts"
  export { processAlive } from "./process-alive.ts"
  export const processId: number = process.pid

  export const lazySqlite =
    (load: () => Promise<{ readonly SqliteClient: { readonly layer: (options: { readonly filename: string }) => Layer.Layer<SqlClient, SqlError> } }>) =>
    (options: { readonly filename: string }): Layer.Layer<SqlClient, SqlError> =>
      Layer.unwrap(Effect.promise(load).pipe(Effect.map(({ SqliteClient }) => SqliteClient.layer(options))))
  ```
  ```ts
  // packages/runtime/src/platform/node.ts (bun.ts mirrors with BunServices / @effect/sql-sqlite-bun)
  import { NodeServices } from "@effect/platform-node"
  import type { Platform } from "./Platform.ts"
  import { lazySqlite } from "./shared.ts"

  export * from "./shared.ts"
  export const platformName: Platform["platformName"] = "node"
  export const PlatformLive: Platform["PlatformLive"] = NodeServices.layer
  export const SqliteLive: Platform["SqliteLive"] = lazySqlite(() => import("@effect/sql-sqlite-node"))
  ```
  ```ts
  // packages/runtime/src/platform/Platform.ts — add processAlive to Platform, then check exact equality:
  type ExactPlatform<M extends Platform> = Exclude<keyof M, keyof Platform> extends never ? M : never
  export type Implementations = [ExactPlatform<typeof NodePlatform>, ExactPlatform<typeof BunPlatform>]
  ```
  Notice `lazySqlite` must live in a separate internal helper (not exported via `export * from "./shared.ts"`) so it does not leak onto `#platform`, or stay in `Platform.ts` / `sqlite-loader.ts`.
- **Line estimate:** ~-10 net lines across `platform/`, and eliminates the recurring 3-file copy-paste whenever a runtime-independent helper is added to `platform/`.
- **Risk and guarding tests:** Low risk. Guarded by `packages/runtime/test/platform.test.ts` (asserts `#platform` resolution and lazy SQLite import on both Node and Bun), `packages/runtime/test/store/claims.test.ts`, and CI's Node 22 / Node 24 / Bun `pnpm check` + `pnpm build` + `--version` matrix.
- **Carrying PR and ripple:** PR 2 (`m1/1-workspace`) owns `Platform.ts`, `node.ts`, `bun.ts`. Tightening `Platform.ts` and extracting `shared.ts` in PR 2 simplifies PR 8 (`31379c7`, `833053d`) and PR 10 (`4668de0`), which each edit `shared.ts` + `Platform.ts` once instead of duplicating exports into both `node.ts` and `bun.ts`.
- **Effect APIs verified:** `Layer.unwrap` (`node_modules/effect/dist/Layer.d.ts:1384`), `NodeServices.layer` (`packages/runtime/node_modules/@effect/platform-node/dist/NodeServices.d.ts:35`), `BunServices.layer` (`packages/runtime/node_modules/@effect/platform-bun/dist/BunServices.d.ts:35`).

---

### S2. `cli/main.ts` executes `runMain` eagerly at top level and provides no shared CLI error contract, duplicating root command setup in tests and `catchCause` across subcommands (and leaving `recoverCommand` unhandled)

- **Location at `origin/m1/7-chat`:** `packages/runtime/src/cli/main.ts:22-29`; ripple at `packages/runtime/src/cli/validate.ts:6-9`, `packages/runtime/src/cli/run.ts:20-29,232-241`, `packages/runtime/src/cli/status.ts:35-42,45-80`, `packages/runtime/src/cli/chat.ts:403-410`, `packages/runtime/test/cli/validate.test.ts:8`, `packages/runtime/test/cli/run.test.ts:10`.
- **Cost to maintainers:** Two separate maintenance leaks grew directly from `main.ts`:
  1. `spindle` is private and `runMain` executes unconditionally on import, so in-process tests (`validate.test.ts:8`, `run.test.ts:10`) cannot import the real root command and must reconstruct partial `Command.make("spindle")` trees that never test `main.ts` wiring.
  2. Because `main.ts` establishes no shared CLI failure type or error boundary, `validate.ts:6` and `run.ts:20` defined two parallel `[Runtime.errorReported] = false` tagged errors (`IssuesFound` and `RunFailed`), `run.ts:232-241`, `status.ts:35-41`, and `chat.ts:403-410` each copy-pasted the same `Effect.catchCause` block to format unexpected failures as `spindle: <msg>` without stack traces, and `recoverCommand` (`status.ts:45-80`) omitted it altogether — so an unexpected `SqlError` in `spindle recover` dumps a raw Effect cause while `spindle status` formats it cleanly.
- **Proposed restructuring:**
  1. Export `spindle` from `packages/runtime/src/cli/main.ts` and guard execution with `if (import.meta.main)` (already proven on Node 22.19+, Node 24, and Bun 1.4.5 in `packages/conformance/src/ledger.ts:117`). Update `validate.test.ts` and `run.test.ts` to import `spindle` directly.
  2. Put one shared `CliReportedError` (or `RunFailed`) with `override readonly [Runtime.errorReported] = false` and one small `catchCliFailures` helper in a shared `packages/runtime/src/cli/errors.ts` (about 20 lines) that every command applies *inside* its own `Console` layer (critical: `run` and `chat` wrap `Console` with `redacting`, so formatting unexpected errors must happen *before* exiting that `Console` scope to guarantee no secret ever leaks to stderr):
     ```ts
     // packages/runtime/src/cli/errors.ts
     export class CliFailed extends Data.TaggedError("CliFailed")<{ readonly message: string }> {
       override readonly [Runtime.errorReported] = false
     }
     export const fail = (message: string) =>
       Console.error(`spindle: ${message}`).pipe(Effect.andThen(Effect.fail(new CliFailed({ message }))))
     export const reportUnexpected = <A, E, R>(
       effect: Effect.Effect<A, E, R>,
       options?: { readonly onTerminated?: (error: ThreadTerminated) => Effect.Effect<never, CliFailed> },
     ) =>
       effect.pipe(
         Effect.catchCause((cause) => {
           const error = Cause.squash(cause)
           if (error instanceof CliFailed || Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
           if (error instanceof ThreadTerminated && options?.onTerminated) return options.onTerminated(error)
           return fail(error instanceof Error ? error.message : String(error))
         }),
       )
     ```
     Apply `reportUnexpected` to `statusCommand` and `recoverCommand` as well as `run`/`send`/`chat`, and let `validateCommand` use `CliFailed` (or keep `IssuesFound` extending the same marker if tests match its tag — checked: no test asserts `_tag === "IssuesFound"`).
- **Line estimate:** ~-25 net lines across `cli/*.ts` and `test/cli/*.test.ts`, plus fixes the missing error handling on `recoverCommand`.
- **Risk and guarding tests:** Low risk if `reportUnexpected` stays inside each command's redacted `Console` scope (`run.ts:246`, `chat.ts:412`). Guarded by `validate.test.ts`, `run.test.ts`, `queue.test.ts`, `ownership.test.ts`, `chat*.test.ts`, and CI's `--version` check.
- **Carrying PR and ripple:** PR 2 (`m1/1-workspace`) for `export const spindle`, `if (import.meta.main)`, and `cli/errors.ts`; ripples cleanly into PR 5 (`validate.ts`), PR 6 (`run.ts`), PR 8 (`status.ts`, `send.ts`), and PR 10 (`chat.ts`).
- **Effect APIs verified:** `Command.run` / `Command.runWith` (`node_modules/effect/dist/cli/Command.d.ts:2782,2988`), `Runtime.errorReported` (`node_modules/effect/dist/Runtime.d.ts:343-385`), `CliError.userMessage` (`node_modules/effect/dist/cli/CliError.d.ts:44-86`). `import.meta.main` verified returning `true` on Node 22 and Bun 1.4.5.

---

### S3. `biome.json` does not block direct relative imports into `src/platform/`, leaving a hole in the `#platform` boundary

- **Location at `origin/m1/7-chat`:** `biome.json:33-62`.
- **Cost to maintainers:** `AGENTS.md:13` specifies that code outside `packages/runtime/src/platform/` reaches platform code exclusively via `#platform` so Node gets `node.ts` and Bun gets `bun.ts`. `biome.json` blocks `node:*`, `bun`, `bun:*`, and `@effect/{platform,sql-sqlite}-{node,bun}`, but allows `import { ... } from "../platform/node.ts"` or `"../platform/chat-terminal.ts"` anywhere in `packages/runtime/src/` or `test/`. A direct relative import silently bypasses `#platform` and `Platform.ts`.
- **Proposed restructuring:** Add `"**/platform"` and `"**/platform/**"` to `overrides[0].linter.rules.style.noRestrictedImports.options.patterns[0].group` in `biome.json:44-57`. (Verified in scratch with Biome 2.6.9: adding those two globs rejects `import { processId } from "../platform/node.ts"` in `src/cli/` with exit code 1, while `packages/runtime/src/platform/**` remains exempt via line 35.)
- **Line estimate:** +2 lines in `biome.json`.
- **Risk and guarding tests:** Zero behavioral risk; `biome check` passes all 521 files cleanly with this rule enabled.
- **Carrying PR and ripple:** PR 2 (`m1/1-workspace`); no rebase conflicts across the stack (PR 4 only edits `includes` on line 35).
- **Effect APIs verified:** N/A (verified directly against installed Biome 2.6.9).

---

### S4. `scripts/spec-requirements.mjs` is 251 lines of untyped, top-level-executing JS with zero unit tests and mutable module state, despite having required six bugfix commits

- **Location at `origin/m1/7-chat`:** `scripts/spec-requirements.mjs:1-251` (module-level mutable `curationProblems` at `164`; unguarded top-level execution at `10-251`).
- **Cost to maintainers:** Six follow-up commits in PR 2 (`c111493`, `f8e5131`, `ce7951a`, `94d6353`, `c8a603f`, `5f0ecf3`) fixed edge cases in markdown block extraction, Windows path separators, empty quotes, and fenced blocks. Unlike `packages/conformance/src/ledger.ts` (TypeScript checked by `tsc`, guarded by `if (import.meta.main)`, backed by 179 lines of unit tests in `ledger.test.ts`), `spec-requirements.mjs` is excluded from `tsconfig.json`, mutates a global `curationProblems` array inside `curate`, executes immediately on import, and has zero unit tests — so parser changes can only be verified by inspecting a 7,100-line JSON diff.
- **Proposed restructuring:** Convert `scripts/spec-requirements.mjs` to TypeScript (e.g. `packages/conformance/src/spec-requirements.ts`, run with `node` just like `packages/conformance/src/ledger.ts`), have `curate` return `{ requirements, problems }` instead of mutating module-level `curationProblems`, guard the CLI entrypoint with `if (import.meta.main)`, and add focused unit tests for `extract` and `locate`/`curate` covering the 6 bug classes PR 2 already hit.
- **Line estimate:** ~0 net lines in the extractor; +70-90 lines of unit tests in `packages/conformance/test/spec-requirements.test.ts`.
- **Risk and guarding tests:** Low risk. Guarded by `pnpm requirements` and CI's `requirements` job (`--refresh --check`).
- **Carrying PR and ripple:** PR 2 (`m1/1-workspace`); no later PR touches `scripts/spec-requirements.mjs`.
- **Effect APIs verified:** N/A (Node 22 native TypeScript stripping is already used in `package.json:16` for `packages/conformance/src/ledger.ts`).

---

### S5. `packages/runtime/package.json` publishes `dist/index.js` without TypeScript declarations

- **Location at `origin/m1/7-chat`:** `packages/runtime/package.json:13-21`, `packages/runtime/tsconfig.build.json:1-8`.
- **Cost to maintainers:** `packages/runtime/package.json` exports `"."` as `./dist/index.js` and ships `"files": ["dist"]`, but `tsconfig.build.json` omits `"declaration": true` and `exports["."]` has no `"types"` entry. It works inside the monorepo only because `tsconfig.base.json` sets `"customConditions": ["spindle-source"]`; any external consumer (or consumer without that custom condition) gets untyped JavaScript. (Note: testing `tsc -p tsconfig.build.json --declaration --noEmit` at tip revealed 3 `TS2883` non-portable inferred-type errors in PR 6's `src/execution/turn.ts:161` and `src/providers/config.ts:76,97` referencing transitive `ZodTypeAny` — enabling declarations in PR 2 would also surface unannotated leaky return types early.)
- **Proposed restructuring:** Add `"declaration": true` and `"declarationMap": true` to `packages/runtime/tsconfig.build.json`, add `"types": "./dist/index.d.ts"` to `packages/runtime/package.json` `exports["."]`, and add explicit return type annotations to `prepareTurn`, `resolveConfig`, and `providerFor` in PR 6.
- **Line estimate:** +5 lines across `tsconfig.build.json`, `packages/runtime/package.json`, and 3 return annotations in PR 6.
- **Risk and guarding tests:** Low risk; verified via `pnpm build` (caught the 3 `TS2883` sites cleanly).
- **Carrying PR and ripple:** PR 2 (`m1/1-workspace`) for config; PR 6 (`m1/4-step-loop`) for the 3 return annotations.
- **Effect APIs verified:** N/A (verified with installed TypeScript 7.0.2).

---

## 3. Effect practice findings

### E1. `onInterrupt` uses a module-level mutable array and raw JS callback disposer instead of a scoped Effect service in `PlatformLive`, forcing `Effect.runForkWith` and an async `let stopping` race in `cli/run.ts`

- **Location at `origin/m1/7-chat`:** `packages/runtime/src/platform/interrupts.ts:3-13`; callers `packages/runtime/src/cli/run.ts:252-281` and `packages/runtime/src/cli/chat.ts:156-160`.
- **Cost to maintainers:** `onInterrupt` mutates a module-level `handlers` array and returns an imperative `() => void` disposer. Both callers pay for this impedance mismatch:
  - `chat.ts:156-160` manually wraps `onInterrupt` in `Effect.acquireRelease` + `Queue.make<void>()` + `Queue.offerUnsafe`.
  - `run.ts:252-281` (`answerInterrupts`) captures `Effect.context<never>()` and `Effect.fiber`, forks fibers via `Effect.runForkWith(context)` inside a raw signal callback, manually wires `Effect.ensuring(..., Effect.sync(() => remove()))`, and mutates `let stopping = false` *after* `yield* supervisor.stop(threadId)` (line 269) — creating a real race where two quick `SIGINT`s both see `stopping === false` and call `stop` twice instead of aborting.
  - Because interrupts are not a `Context.Service`, unit tests cannot inject synthetic interrupts without spawning child OS processes.
- **Proposed restructuring:** Replace `onInterrupt` with a scoped `Interrupts` `Context.Service` provided by `PlatformLive` (still backed by the same `SIGINT`/`SIGTERM`/`SIGHUP` wiring in `runMain`):
  ```ts
  // packages/runtime/src/platform/interrupts.ts
  export class Interrupts extends Context.Service<
    Interrupts,
    { readonly subscribe: Effect.Effect<Queue.Dequeue<void>, never, Scope.Scope> }
  >()("spindle/Interrupts") {}

  const queues: Array<Queue.Queue<void>> = []

  export const InterruptsLive = Layer.succeed(Interrupts, {
    subscribe: Effect.acquireRelease(
      Effect.gen(function* () {
        const queue = yield* Queue.make<void>()
        queues.push(queue)
        return queue
      }),
      (queue) =>
        Effect.sync(() => {
          const i = queues.lastIndexOf(queue)
          if (i !== -1) queues.splice(i, 1)
          Queue.endUnsafe(queue)
        }),
    ),
  })
  ```
  In `runMain`, `onSignal` checks `queues.at(-1)` on `SIGINT` and calls `Queue.offerUnsafe(top, undefined)` instead of invoking an arbitrary JS callback.
  - `chat.ts:156-160` collapses from 5 lines to `const interrupts = yield* Interrupts.use((i) => i.subscribe)`.
  - `run.ts:252-281` (`answerInterrupts`) becomes a scoped fiber sequentially reading `Queue.take(interrupts)` (first take → `stop`, second take → `abort`, deleting `Effect.context`, `Effect.runForkWith`, `Effect.ensuring`, and the `let stopping` race).
- **Line estimate:** ~+10 lines in `interrupts.ts`/`Platform.ts`, ~-20 lines across `run.ts` and `chat.ts` (net ~-10 lines, removes the `stopping` race, and makes interrupt paths unit-testable).
- **Risk and guarding tests:** Low risk; `runMain` retains exact fallback to `fiber.interruptUnsafe(fiber.id)` when `queues` is empty and preserves the stdout/stderr flush + `process.exit(code)` behavior (commit `b3aff72`). Guarded by `packages/runtime/test/cli/queue.test.ts` and `packages/runtime/test/cli/chat-interrupt.test.ts`.
- **Carrying PR and ripple:** PR 8 (`m1/6-queue`, commit `31379c7`) introduced `interrupts.ts` and `answerInterrupts`; ripples into PR 10 (`chat.ts`).
- **Effect APIs verified:** `Context.Service` (`node_modules/effect/dist/Context.d.ts:196`), `Queue.make` / `Queue.endUnsafe` (`node_modules/effect/dist/Queue.d.ts:431,1219`), `Effect.acquireRelease` (`node_modules/effect/dist/Effect.d.ts:13169`), `Runtime.makeRunMain` (`node_modules/effect/dist/Runtime.d.ts:232`).

---

### E2. Confirmed `@effect/tsgo` diagnostic in PR 2: `preferTypedSchemaDecoder` (`TS377112`) in `packages/runtime/src/cli/main.ts:18`

- **Location at `origin/m1/7-chat`:** `packages/runtime/src/cli/main.ts:18`.
- **Cost to maintainers:** `fs.readFileString(file)` already produces `string`, which is `PackageJson["Encoded"]` (`Schema.fromJsonString(...)`). Passing it to `Schema.decodeUnknownEffect` discards compile-time input type checking. (This is the sole default-rule `@effect/tsgo` diagnostic across all files owned by PR 2.)
- **Proposed restructuring:** Replace `Schema.decodeUnknownEffect(PackageJson)` with `Schema.decodeEffect(PackageJson)`.
- **Line estimate:** 0 net lines.
- **Risk and guarding tests:** Zero risk; guarded by `pnpm typecheck`, `pnpm build`, and CI's `spindle --version` check.
- **Carrying PR and ripple:** PR 2 (`m1/1-workspace`); no conflicts in later PRs.
- **Effect APIs verified:** `Schema.decodeEffect` (`node_modules/effect/dist/Schema.d.ts:1253`).

---

### E3. `processId` and `processAlive` are imported as ambient globals from `#platform` rather than a `Context.Service`, and `process-alive.ts` uses raw `try/catch` + `as NodeJS.ErrnoException`

- **Location at `origin/m1/7-chat`:** `packages/runtime/src/platform/node.ts:12,22`, `packages/runtime/src/platform/bun.ts:12,21`, `packages/runtime/src/platform/process-alive.ts:3-14`, `packages/runtime/src/store/sqlite.ts:5,602-604,625`, `packages/runtime/src/execution/ThreadSupervisor.ts:3,123`.
- **Cost to maintainers:** `store/sqlite.ts` and `ThreadSupervisor.ts` import `processId` and `processAlive` directly from `#platform` instead of declaring a service in their Effect `R` channel. That hides the OS process dependency from type signatures and forces dead-process recovery tests either to insert bogus/self PIDs (`claims.test.ts:79`) or spawn real child processes (`ownership.test.ts`). Inside `process-alive.ts:9`, `const code = (error as NodeJS.ErrnoException).code` uses an unsafe type assertion inside a manual `try/catch`.
- **Proposed restructuring:**
  - *Minimum fix (zero test ripple):* Narrow `error` safely without a cast (`typeof error === "object" && error !== null && "code" in error ? error.code : undefined`) and add `processAlive` to `Platform.ts` (per S1).
  - *Full Effect service (recommended if M2+ adds more process-table tests):* Define `HostProcess` (`Context.Service<HostProcess, { readonly pid: number; readonly isAlive: (pid: number) => Effect.Effect<boolean> }>()("spindle/HostProcess")`) provided by `PlatformLive`, and inject it into `sqlite.ts` and `ThreadSupervisor.ts` instead of importing from `#platform`. Note: `claims.test.ts`, `contract.test.ts`, `unfenced.test.ts`, `history.test.ts`, and `hooks.test.ts` construct `SqliteLive` without `PlatformLive`, so they would add `HostProcessLive` (or `PlatformLive`) to their store test layer.
- **Line estimate:** Minimum fix: 0 lines; `HostProcess` service: ~+15 lines in `platform/`, removes `#platform` imports from `sqlite.ts` and `ThreadSupervisor.ts`, +1 line in 5 store test helpers.
- **Risk and guarding tests:** Low risk. Guarded by `packages/runtime/test/store/claims.test.ts` and `packages/runtime/test/cli/ownership.test.ts`.
- **Carrying PR and ripple:** PR 8 (`m1/6-queue`, commits `31379c7` and `833053d`).
- **Effect APIs verified:** `Context.Service` (`node_modules/effect/dist/Context.d.ts:196`).

---

### E4. `platform/chat-terminal.ts` requires `Terminal.Terminal` while directly binding `process.stdin`/`process.stdout`, and does not close its `lines` queue in its finalizer

- **Location at `origin/m1/7-chat`:** `packages/runtime/src/platform/chat-terminal.ts:3-59` (lines 4, 7-8, 28, 35-42, 56).
- **Cost to maintainers:** `openChatTerminal` yields `Terminal.Terminal` solely to call `terminal.display(text)` (line 56), while attaching listeners directly to `process.stdin` and `process.stdout` (lines 7-8, 28-34). The `Terminal.Terminal` requirement in `R` implies stdout is abstracted behind the service, yet providing a fake `Terminal` layer still binds real `process.stdin`/`process.stdout`. Separately, the scope finalizer (lines 35-42) detaches stdin listeners without calling `Queue.endUnsafe(lines)`, so a scope close while a fiber is blocked on `readLine` relies solely on fiber interruption rather than ending the queue cleanly.
- **Proposed restructuring:** Keep `chat-terminal.ts` in `src/platform/` (settled by `docs/plans/briefs/m1-7.md:23`), add `Queue.endUnsafe(lines)` to the finalizer, and either write directly to `output` (removing the misleading `Terminal.Terminal` requirement) or expose `ChatTerminal` as a `Context.Service` provided by `PlatformLive` so `cli/chat.ts` no longer imports `openChatTerminal` directly from `#platform`.
- **Line estimate:** +1 to +10 lines depending on whether `ChatTerminal` is wrapped as a service.
- **Risk and guarding tests:** Low-medium risk because closed-pipe error timing differs between Node and Bun (note the `setImmediate` on line 40). Guarded by `packages/runtime/test/cli/chat.test.ts`, `chat-interrupt.test.ts`, and `chat-shared.test.ts` (including F25 closed-output and PTY tests).
- **Carrying PR and ripple:** PR 10 (`m1/7-chat`, commit `4668de0`); no downstream PRs.
- **Effect APIs verified:** `Terminal.Terminal` (`node_modules/effect/dist/Terminal.d.ts:30-58`), `Queue.endUnsafe` (`node_modules/effect/dist/Queue.d.ts:1219`).

---

### E5. `packages/conformance/src/ledger.ts` calls raw `JSON.parse` three times instead of `Schema.fromJsonString`

- **Location at `origin/m1/7-chat`:** `packages/conformance/src/ledger.ts:32-40,130-138` (flagged by `@effect/tsgo` `globalJson`).
- **Cost to maintainers:** `ledger.ts` already formats schema validation errors onto a single line (`decode`, lines 32-38), and `cli/main.ts:12` already uses `Schema.fromJsonString`. Calling raw `JSON.parse` before `decode` throws an uncaught `SyntaxError` stack trace if `ledger.json`, `requirements.json`, or `vitest.json` contains malformed JSON.
- **Proposed restructuring:** Add `const decodeJson = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, file: string, options?: SchemaAST.ParseOptions) => decode(Schema.fromJsonString(schema), file, options)` for lines 131-138 while keeping exported `decodeLedger` accepting `unknown` so existing object-based tests in `ledger.test.ts:132-151` remain unchanged.
- **Line estimate:** ~-2 net lines.
- **Risk and guarding tests:** Low risk; guarded by `packages/conformance/test/ledger.test.ts` and `pnpm ledger`.
- **Carrying PR and ripple:** PR 2 (`m1/1-workspace`); no conflicts in later PRs.
- **Effect APIs verified:** `Schema.fromJsonString` (`node_modules/effect/dist/Schema.d.ts:7292`), `Schema.decodeUnknownResult`.

---

## 4. Should `@effect/tsgo` be added to the workspace and `pnpm check`?

**Yes.** Add `@effect/tsgo@0.73.7` (matching `typescript@7.0.2`) as a root `devDependency` in PR 2, configure the `@effect/language-service` plugin in root `tsconfig.json`, and **replace `pnpm typecheck` (`tsc --noEmit -p tsconfig.json`) with `effect-tsgo tsc --noEmit -p tsconfig.json`**.

### Operational findings verified in scratch (at `origin/m1/7-chat`, `43a4d5b`)

1. **No `prepare` script or `node_modules` patching is needed for `pnpm check`.** Running `effect-tsgo unpatch --typescript` and then `pnpm exec effect-tsgo tsc --noEmit -p tsconfig.json` runs the Effect-patched Go `tsc` binary directly from `@effect/tsgo` without mutating `node_modules`. Developers who also want IDE diagnostics can run `effect-tsgo patch --typescript` locally or point their editor at `effect-tsgo tsc@7.0.2 --lsp --stdio`.
2. **Negligible overhead and works on both Node and Bun.** Wall-clock time across the entire stack was **0.87s** (`pnpm exec effect-tsgo tsc --noEmit -p tsconfig.json`), and `bun --bun x effect-tsgo tsc --noEmit -p tsconfig.json` works identically. Putting `"plugins"` in root `tsconfig.json` (not `tsconfig.base.json`) leaves `pnpm build` (`packages/runtime/tsconfig.build.json`) unaffected.
3. **Exit-code semantics (critical for choosing severities):**
   - `effect-tsgo tsc` exits **`1`** on any **`error`** or **`warning`**, and exits **`0`** when only **`suggestion`** (`message`) diagnostics remain.
   - `effect-tsgo diagnostics --project tsconfig.json` exits **`0`** on `warning` unless `--strict` is passed, and exits **`1`** on `error`.
   - Using `effect-tsgo tsc` as `pnpm typecheck` gives one unified ~0.9s check where `error`/`warning` gate CI and `suggestion` remains visible without blocking.

### Full-stack diagnostic census (all 154 rules at `origin/m1/7-chat`)

Running with default rules produced **602** `unstableApiUsage` warnings plus **41** real diagnostics (0 errors, 7 warnings, 34 suggestions). Enabling all 54 off-by-default rules (with `unstableApiUsage: "off"`) produced **3,297** diagnostics across **43** rules. After reading the flagged source lines across `packages/runtime/src/`:

- **Real bugs / Effect anti-patterns caught by default rules (all 7 warnings + highest-value suggestions):**
  - `unknownInEffectCatch` (5 in `src/`: `execution/call.ts:372`, `execution/tools.ts:104,120`, `registry/Registry.ts:282`, `registry/load-packages.ts:144` — all `catch: (cause) => cause` leaking `unknown`).
  - `globalErrorInEffectFailure` (2 in `src/`: `execution/thread-state.ts:226,303` — `Effect.fail(new Error(...))`).
  - `tryCatchInEffectGen` (5 in `src/`: `execution/hooks.ts:501`, `execution/tools.ts:130`, `registry/validate.ts:525,584`, `store/sqlite.ts:551`).
  - `returnEffectInGen` (2 in `src/`: `providers/config.ts:130,132` — `providerFor` returns a nested `Effect<Effect<LLMProviderInterface>>`).
  - `schemaNumber` (2 in `src/`: `providers/script.ts:27,28` — `statusCode` and `retryAfter` accept `NaN`/`Infinity` instead of `Schema.Finite`).
  - `preferTypedSchemaDecoder` (1 in `src/`: `cli/main.ts:18` — `decodeUnknownEffect` on a `string`).
  - `flatMapMapToZipWith` (1 in `src/`: `store/sqlite.ts:365`), `effectSucceedWithUndefined` (6: 2 `src/`, 4 `test/`), `unnecessaryEffectGen` (7 in `test/`), `provideLayerSucceedToProvideService` (4 in `test/cli/run.test.ts`), `catchToOrElseSucceed` (3 in `test/cli/`), `flatMapToTap` (3 in `test/cli/`).
- **Real defects / anti-patterns caught only when enabling specific off-by-default rules:**
  - `unsafeEffectTypeAssertion` (**1 hit** across entire repo: `execution/hooks.ts:467` — unsafe cast narrowing the Effect return type).
  - `missingConcurrencyOption` (**8 hits**: 3 in `src/` including `registry/load-packages.ts:207` where three independent `fs.realPath`/`fs.stat` calls in `Effect.all` run sequentially by accident, plus `execution/step.ts:309,449`; 4 in `test/`; 1 in `scripts/queue-probe.ts:73`).
  - `effectTryWithoutCatch` (**1 hit**: `scripts/queue-probe.ts:128`).
  - `globalDateInEffect` (**0 hits** in `src/`, 6 in `test/` — protects `Clock` discipline in `src/` with zero production debt).
  - `anyUnknownInErrorContext` (**209 hits**: 37 in `src/`, 163 in `test/`, 9 in `scripts/` — catches real `unknown` leaks in `store/sqlite.ts:79`, `cli/main.ts:28`, `cli/run.ts`, `cli/chat.ts`, `registry/Registry.ts:280`, though too noisy in `test/` until test helpers drop `unknown`).

### Recommended `diagnosticSeverity` configuration in `tsconfig.json`

| Severity | Rules | Rationale & current hits at `43a4d5b` |
|---|---|---|
| **`"error"`** | All 13 default error rules (`floatingEffect`, `floatingEffectInVitest`, `missingEffectContext`, `missingEffectError`, `missingLayerContext`, `missingReturnYieldStar`, `missingStarInYieldEffectGen`, `classSelfMismatch`, `effectFnImplicitAny`, `nonObjectEffectServiceType`, `overriddenSchemaConstructor`, `schemaLiteralNonFinite`, `schemaOpaqueInstanceMember`), **plus promote:** `unsafeEffectTypeAssertion`, `effectInFailure`, `effectInVoidSuccess`, `promiseInEffectSuccess`, `lazyPromiseInEffectSync`, `scopeInLayerEffect`, `layerMergeAllWithDependencies`, `duplicatePackage` | Unambiguous correctness bugs. Only 1 hit across the entire stack (`hooks.ts:467`, `unsafeEffectTypeAssertion`). |
| **`"warning"`** (gates `effect-tsgo tsc`) | `unknownInEffectCatch` (5), `globalErrorInEffectFailure` (2), `globalErrorInEffectCatch` (0), `tryCatchInEffectGen` (5), `returnEffectInGen` (2), `schemaNumber` (2), `preferTypedSchemaDecoder` (1), `missingConcurrencyOption` (8), `effectTryWithoutCatch` (1), `globalDateInEffect` (6 test / 0 src) | Directly enforces Spindle's Effect standards (typed errors, no `try/catch` in `Effect.gen`, explicit concurrency, `Clock` over `Date`, finite schema numbers). Total cleanup across the whole stack is ~32 small fixes (or 2 inline disables on `providers/config.ts:130,132` if nested `Effect` stays intentional). |
| **`"suggestion"`** (default `message`; printed, exit 0) | Remaining default suggestion rules (`effectSucceedWithUndefined`, `unnecessaryEffectGen`, `flatMapMapToZipWith`, `flatMapToTap`, `catchToOrElseSucceed`, `provideLayerSucceedToProvideService`, `effectFnOpportunity`, etc.) | Good readability nudges without blocking CI; keep defaults. |
| **`"off"`** | **`unstableApiUsage`** (602 hits — **must turn off**), and keep off: `apiStabilityLeak` (85), `asyncFunction` (789 — spec callbacks are Promise-based), `preferEffectArray` (773), `preferEffectString` (187), `preferEffectRecord` (58), `yieldInCallArgument` (354), `strictEffectProvide` (224 — noisy in tests and CLI subcommands), `strictBooleanExpressions` (131), `globalJson` / `globalJsonInEffect` (131 / 51 — fires on every `JSON.stringify`), `missingPipeableSignature` (59 — app runtime, not dual-API library), `preferSchemaTaggedError` (26 — `Data.TaggedError` is right for non-serialized internal errors), `deterministicKeys` (3 — Spindle intentionally uses `"spindle/<Name>"`), `globalFetch` (1 — `openaiCompatible` implements spec's `FetchLike`), `nodeBuiltinImport` / `globalConsole` / `globalTimers` / `newPromise` (already governed by `biome.json` in `runtime/src/`), `cryptoRandomUUID*` (13 — Web Crypto UUIDs are fine unless deterministic IDs are wanted), and `anyUnknownInErrorContext` (until the 37 `src/` + 163 `test/` `unknown` channels are cleaned up, after which it can be raised to `"warning"`). | Prevents 3,200+ false positives and style churn that contradict the spec's Promise interfaces or Biome's existing boundary rules. |

---

## 5. Duplication with code from other pull requests

- **`Command.make("spindle")` root command assembly** is duplicated in `packages/runtime/src/cli/main.ts:22-24`, `packages/runtime/test/cli/validate.test.ts:8`, and `packages/runtime/test/cli/run.test.ts:10` because `main.ts` does not export `spindle` behind `if (import.meta.main)`.
- **Silent CLI exit errors (`[Runtime.errorReported] = false`)** are duplicated between `IssuesFound` (`cli/validate.ts:6-9`, PR 5) and `RunFailed` (`cli/run.ts:20-23`, PR 6), and the `Effect.catchCause` error-to-stderr boilerplate is duplicated across `cli/run.ts:232-241`, `cli/status.ts:35-41`, and `cli/chat.ts:403-410` (while omitted in `recoverCommand`).
- **Schema error one-line collapsing (`error.message.replaceAll(/\s*\n\s*/g, " ")`)** is repeated in `packages/conformance/src/ledger.ts:37` (PR 2), `packages/runtime/src/cli/run.ts:42` (PR 6), and `packages/runtime/src/cli/chat.ts:83` (PR 10 — where `readScript` also duplicates `loadScript` from `cli/run.ts:35-45`).
- **`plural(count, word)`** is duplicated in `packages/runtime/src/cli/validate.ts:17` and `packages/runtime/src/cli/run.ts:144` (with an inline ternary in `cli/chat.ts:357` and a 3-arg variant in `execution/tools.ts:248`).

---

## 6. What is good and should not be touched

- **Conditional `#platform` resolution via `package.json` `imports` + `spindle-source` condition** (`packages/runtime/package.json:22-31`, `tsconfig.base.json:7`, `vitest.config.ts:6-12`). Running from source under `tsc`/Vitest and from `dist` under plain Node/Bun without a bundler is clean and minimal.
- **Lazy dynamic import of `@effect/sql-sqlite-{node,bun}`** (`node.ts:14-20`, `bun.ts:14-19`) and the regression test in `packages/runtime/test/platform.test.ts:23-29`. Avoiding Node 22's `node:sqlite` `ExperimentalWarning` on commands that do not open a database is well-tested and clean.
- **Strict TypeScript 7 baseline** (`tsconfig.base.json:9-16`: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `rewriteRelativeImportExtensions`).
- **Biome platform boundary rules for `node:*`, `bun:*`, platform packages, and `process`/`Bun`/`Buffer` globals** (`biome.json:28-76`), plus the `vitest.config.ts` runtime project label (`|node|` / `|bun|`).
- **`packages/conformance/src/ledger.ts` core logic and `packages/conformance/test/ledger.test.ts`**. `checkLedger`, `duplicateKeys`, and `decodeLedger` (`onExcessProperty: "error"`) are concise, pure, well-tested, and guard real conformance-ledger failure modes without unnecessary abstraction.
- **Reading `../../package.json` via `FileSystem` + `Path` in `cli/main.ts:14-20`**. Because `packages/runtime/tsconfig.build.json` sets `"rootDir": "src"`, a static JSON import of `../../package.json` would fail `tsc`; reading it via Effect's `FileSystem`/`Path` is the right approach (only `decodeUnknownEffect` → `decodeEffect` needs changing).
- **Flushing stdout/stderr before `process.exit(code)` in `platform/interrupts.ts:27`**. Verified in scratch on both Node 22 and Bun 1.4.5 that `process.stdout.write("", cb)` invokes `cb` and exits with the expected code even when `stdout` is already destroyed or backed by a closed pipe.

---

## 7. What could not be judged

- **Node 24 runtime behavior:** Only Node `22.22.3` and Bun `1.4.5` are installed locally, so `effect-tsgo` and `process.stdout.write` edge cases were verified on Node 22 and Bun 1.4.5, not on Node 24 (covered by CI's matrix in `.github/workflows/ci.yml:20-23`).
- **`scripts/seed-ledger.mjs` milestone classification rules (`RULES` at lines 15-62):** Per the brief, `docs/`, `ledger.json`, and `requirements*.json` are out of scope; the file itself is a short, readable 77-line one-off seeder with no structural issues worth changing.
- **Whether `pnpm install`'s missing-bin warning (`ENOENT: .../packages/runtime/dist/cli/main.js`) matters to the operator:** It is benign in workspace development (resolved as soon as `pnpm build` runs) and would only justify a committed `bin/` shim if contributors invoke `pnpm exec spindle` before building.
