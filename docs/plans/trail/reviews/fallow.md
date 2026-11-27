# Fallow Assessment for `zacharytamas/spindle-runtime`

Evaluated against commit `38c421c` (`origin/m1/9-test-harness`) in a clean scratch copy (`/tmp/fallow-scratch/repo`) using `fallow@3.49.0` and `fallow-type-aware@3.49.0`, with all network checks disabled (`DO_NOT_TRACK=1 FALLOW_TELEMETRY_DISABLED=1 FALLOW_UPDATE_CHECK=off`). No files were changed in the repository.

---

## 7. Verdict: Should Spindle Add Fallow Now?

**Yes — add it now as a pinned root `devDependency` with `.fallowrc.json`, and run `fallow audit` in a dedicated CI job (advisory during the M1 restructuring stack, then blocking new regressions on PRs once the stack lands). Do not add it to blocking `pnpm check` until the existing dead-code backlog is cleared.**

**Main reason.** For roughly 0.3 seconds locally (and ~0.8 seconds for a PR diff audit), with no telemetry and working out-of-the-box support for TypeScript 7.0.2, pnpm workspaces, `.ts` extensions, and `#platform` conditional imports, Fallow covers three real gaps that Biome, `tsc`, and `@effect/tsgo` cannot see: cross-file unused exports and types (29 real findings), runtime circular dependencies (it caught 2 genuine value cycles in `packages/runtime/src/registry/` that all seven manual reviews missed), and objective complexity/duplication guards against LLM-authored bloat. Once configured to ignore test fixtures and turn off static-estimated CRAP scores, its dead-code findings hit 31/31 real issues and its 30 complexity findings closely match the exact functions the seven reviewers flagged.

**What would change the answer to No:**

- **If you want zero extra tool dependencies during M1.** Running Fallow on demand before releases or refactor passes captures most of the value without adding a package to `package.json`, since it is a standalone binary.
- **If the main goal were catching unused `Context.Service` methods, unread object fields, or 1-line helper copies.** Fallow missed `ThreadStore.appendMessages`, missed `Delivery.elsewhere`, and missed the 13 copies of `isRecord` under its defaults. If those were the primary target, Fallow would not pay for itself.
- **If single-maintainer churn becomes a burden.** Fallow is 8 months old, maintained almost entirely by one person, and ships minor releases every few days. Pinning an exact version in `package.json` insulates Spindle from surprise changes; if a future TypeScript 7 or Effect v4 change breaks it, removing one `devDependency` and `.fallowrc.json` is low-cost.

---

## 1. What Fallow Is

*(Sources: [fallow.tools](https://fallow.tools/), [fallow.tools/docs](https://fallow.tools/docs/), [fallow.cloud](https://fallow.cloud/), and the `fallow-rs/fallow` GitHub repository at `v3.49.0`, checked directly via `README.md`, `LICENSE`, `Cargo.toml`, `schema.json`, and `fallow --help`.)*

Fallow is a static codebase analyzer for TypeScript and JavaScript written in Rust. Instead of checking one file at a time like a linter, it parses an entire repository once using [Oxc](https://oxc.rs) (and `lightningcss` for stylesheets) to build a single graph of files, imports, exports, dependencies, functions, and CSS tokens, then runs multiple analyses over that graph. Core static analysis needs no Node.js runtime and no TypeScript compiler.

### Local Open-Source Tool vs. Hosted Commercial Service

The site describes two distinct products from the same maker:

1. **Fallow (`fallow.tools`, open source, MIT license, $0, no account).** The local analyzer: CLI (`fallow`), Language Server (`fallow-lsp`), MCP server (`fallow-mcp`), VS Code extension, Node bindings (`@fallow-cli/fallow-node`), and GitHub Action (`fallow-rs/fallow@v3`). It also supports local single-capture runtime coverage (`fallow-cov`) without a license.
2. **Fallow Cloud (`fallow.cloud`, commercial SaaS, $20/seat/month after a 30-day trial, Enterprise on request).** An optional hosted runtime-intelligence layer (servers hosted in Amsterdam, EU). Teams install a production beacon that counts how often each function runs across deployments (without capturing arguments, return values, or user data) and sends those counts to `fallow.cloud`. The CLI can optionally query those counts via `fallow coverage analyze --cloud`, authenticated via `fallow cloud login` / `FALLOW_API_KEY` and an Ed25519-signed license JWT (`fallow license`). None of this is needed for local static analysis.

### What It Analyses and Reports

Every command supports human terminal output plus machine-readable formats (`json` with a published schema in `docs/output-schema.json`, `sarif`, `markdown`, `codeclimate`, `gitlab-codequality`, `github-annotations`, PR comment/review formats, and SVG health badges). Exit codes are documented: `0` means clean (or `audit` pass/warn), `1` means error-severity findings (or `audit` fail), `2` means invalid input or a runtime error, `3` means a missing resource, `8` is the opt-in security gate, and `4–7`/`10–13` cover cloud/license/network errors.

- **Dead code (`fallow dead-code`):** Starting from entry points (auto-detected from `package.json` `main`/`exports`/`bin`/`scripts`, TypeScript configs, and 100+ framework plugins), finds unreachable files, unimported exports and types, unused `package.json` dependencies/devDependencies/optionalDependencies, unlisted dependencies/binaries, unresolved imports, unused class/enum/namespace members, duplicate export names across modules, circular dependencies, and (when `effect` is in dependencies) three Effect-specific checks: unused `Layer` chains (`unused-effect-layer`), unused `Data.TaggedError` classes (`unused-tagged-error`), and `catchTag` handlers whose tag nothing produces (`unproduced-catch-tag`).
- **Type-aware refinement (`--type-aware`):** An optional semantic pass using a separate `fallow-type-aware` companion package (which bundles TypeScript 7, ~30 MB) to verify exact TypeScript symbol identities across aliases, re-exports, and `implements` interface contracts, and to report **private type leaks** (exported functions/types whose public signature references a non-exported file-private type). It does not run `tsc` type diagnostics or typed lint rules.
- **Duplication (`fallow dupes`):** Finds copy-pasted code blocks using token-stream suffix-array matching over AST tokens. Modes range from `strict`/`mild` (exact tokens, ignoring whitespace/comments; default `mild`, minimum 50 tokens and 5 lines, 2+ occurrences) to `weak` (blinds string literals) and `semantic` (blinds identifiers and literals so renamed-variable copies match). Optional `--near` adds bounded function-scoped near-miss (gapped) clones.
- **Health and complexity (`fallow health`):** Computes per-function **cyclomatic complexity** (count of independent control-flow paths; default max 20), **cognitive complexity** (nesting-weighted reading difficulty; default max 15), **unit size** (function lines; default max 60), optional **file lines** (`maxFileLines`, default `0` = off), and **CRAP score** (*Change Risk Anti-Patterns*: `CC^2 * (1 - coverage)^3 + CC`, combining complexity with test coverage; default max 30.0). Without an Istanbul/V8 coverage file, Fallow estimates coverage statically from whether test entry points can reach a file. Also computes a 0–100 **health score** (letter grade), **hotspots** (combining complexity with git commit churn), refactoring **targets**, **coverage gaps**, and optional CSS token drift (`--css`).
- **Architecture (`fallow architecture`, `fallow guard`):** Checks circular dependencies (file, re-export, and workspace-package cycles), configured architectural layer boundaries (`boundaries`), and declarative policy rule packs (`rulePacks`).
- **Changed-file PR gate (`fallow audit`):** Compares `HEAD` against a base ref (`--base <ref>`) using a temporary git worktree and reports `pass`, `warn`, or `fail` strictly on findings introduced or worsened by the change, ignoring inherited findings.
- **Opt-in analyses (not part of bare `fallow`):**
  - `fallow flags`: heuristic detection of feature-flag SDK calls.
  - `fallow security`: static taint/sink candidate scanner ranked by entry-point reachability.
  - `fallow similar-code`: compares whole-function meaning using a pinned ~324 MB local embedding model (`fallow-similar-code` companion; requires explicit download confirmation).
  - `fallow mutation`: mutation testing (injects small source changes and runs the project's test runner, supporting Vitest `>=4.1.0 <6.0.0`).
- **Inspection & visualization:** `fallow list`, `fallow trace`, `fallow inspect`, `fallow explain`, `fallow doctor`, `fallow recommend`, `fallow viz` (interactive HTML map).

### What It Can Auto-Fix (`fallow fix`)

*(From `fallow.tools/docs/guides/auto-fix/` and tested with `fallow fix --dry-run`.)*

`fallow fix` previews changes with `--dry-run` and applies them with `--yes` (required in non-interactive shells). It only performs narrow, low-risk edits:

- Removes the `export` keyword from unused exports (keeps the declaration in the file; exception: an unused exported `enum` is removed entirely).
- Removes unused dependency entries from `package.json` and unused pnpm catalog entries from `pnpm-workspace.yaml`.
- Removes unused enum members (when no intervening comments would be lost).
- Removes unused class members **only** when `--type-aware` proves they have no consumers.
- Adds `ignoreExports` entries to `.fallowrc.json` for `duplicate-exports` findings (creating `.fallowrc.json` if absent).

It **never** deletes unused files, never deletes function bodies, and never adds unlisted dependencies.

### Maker, License, Maturity, and Installation

- **Maker:** **Bart Waardenburg** (`@BartWaardenburg`), through **Fallow B.V.** (Rijswijk, Netherlands; Dutch KVK `42095869`). On GitHub, `BartWaardenburg` accounts for 5,083 commits; the next human contributor has 43 commits (`dependabot[bot]` has 669).
- **License:** **MIT** (`fallow-rs/fallow/LICENSE`, Copyright 2026 Bart Waardenburg).
- **Maturity:** Repository created **2026-03-17** (~8 months old at evaluation on 2026-11-26). Currently at **v3.49.0** with **5,415 GitHub stars**, **213 forks**, **44 open issues**, CodSpeed performance tracking, OpenSSF baseline badge, and signed release binaries (verified locally during npm install). Release pace is very fast (8 releases in the 16 days from Nov 10 to Nov 26). Documentation does not specify a long-term support policy for older CLI JSON schema versions beyond `docs/backwards-compatibility.md`.
- **Installation:** `pnpm add -D fallow` (and optionally `fallow-type-aware@<same-version>`), `npx fallow`, `cargo install fallow-cli`, Homebrew, release archives, or Docker. The npm package ships `fallow`, `fallow-lsp`, and `fallow-mcp` wrappers around platform-specific native binaries (`@fallow-cli/darwin-arm64`, etc.).

---

## 2. What It Sends Anywhere (Privacy & Network Behavior)

*(Verified from `docs/telemetry.md`, `docs/environment-variables.md`, `crates/cli/src/telemetry.rs`, `crates/types/src/telemetry_opt_out.rs`, `crates/cli/src/update_check.rs`, `crates/cli/src/license/mod.rs`, and running `fallow telemetry status` locally.)*

**Bottom line:** Core static analysis runs **100% locally** with no account, no login, and no network connection required. However, there is one quiet background check worth knowing about on interactive terminals.

1. **Product telemetry — off by default.** Confirmed in source (`telemetry.rs`) and by running `fallow telemetry status` (`Telemetry: off (default)`, `Install grouping token: none`, `Explicit decision: no`). It is never turned on automatically by CI or coding agents. Only an explicit `fallow telemetry enable` or `FALLOW_TELEMETRY=on` sends coarse workflow events to `https://api.fallow.cloud/v1/telemetry/events` with a random install header (`X-Fallow-Install`). Even when enabled, the docs and source state it never collects repository names, file paths, package names, source code, config values, or raw errors.
2. **Version update check — runs once per 24h on interactive human TTYs unless disabled.** Verified directly in `crates/cli/src/update_check.rs`: when stdout and stderr are TTYs, output format is `human`, `--quiet` is not set, and not in CI, Fallow fires a background `GET https://api.fallow.cloud/v1/cli/latest-version` (1s timeout, cached 24h) to show an upgrade nudge on the next run. It sends no repo name, path, or code, and is automatically suppressed in CI, non-TTY shells, `--quiet`, and `--format json`. It is completely disabled by setting any of `DO_NOT_TRACK=1`, `FALLOW_TELEMETRY_DISABLED=1`, or `FALLOW_UPDATE_CHECK=off`.
3. **Opt-in network commands (never run unless explicitly called):**
   - `fallow cloud login` / `fallow coverage analyze --cloud`: talks to `api.fallow.cloud` (transmits repository names and requested runtime-coverage lookups).
   - `fallow license activate --trial` / `fallow license refresh`: talks to `api.fallow.cloud`.
   - `fallow type-aware setup`: downloads the signed `fallow-type-aware` tarball from GitHub Releases (not needed when installed via npm/pnpm).
   - `fallow similar-code setup --local`: downloads a ~324 MB local model after explicit user confirmation.
   - `--allow-remote-extends`: allows `https://` config inheritance (off by default).

**How it was run for this evaluation:** `fallow@3.49.0` and `fallow-type-aware@3.49.0` were installed into `/tmp/fallow-scratch/tool` via npm, and every command was executed with `DO_NOT_TRACK=1 FALLOW_TELEMETRY_DISABLED=1 FALLOW_UPDATE_CHECK=off --format json --quiet` against `/tmp/fallow-scratch/repo`. No account was created, no cloud or `similar-code` commands were run, and no repository content or metadata left the machine.

---

## 3. Whether It Runs Here

Tested on `/tmp/fallow-scratch/repo` (clean clone of `38c421c` with `pnpm install --frozen-lockfile`).

### Worked Immediately (Zero Config)

- **TypeScript 7.0.2 & `.ts` import extensions (`rewriteRelativeImportExtensions`):** Parsed all 463 files with 0 parse errors and 0 unresolved imports.
- **pnpm workspace:** Discovered both workspace packages (`spindle-runtime` and `spindle-conformance`) and recognized `spindle-runtime` as an internal workspace dependency.
- **`package.json` `imports` with conditions (`#platform` -> `node.ts` / `bun.ts`):** Worked out of the box with zero resolver configuration. Verified with `fallow trace --path` and `fallow dead-code --trace`: Fallow resolved `#platform` to **both** `packages/runtime/src/platform/node.ts` and `packages/runtime/src/platform/bun.ts`, crediting all 12 value importers (starting at `packages/runtime/src/cli/main.ts:5`) and `Platform.ts`'s type-only imports to both files. Neither platform adapter was flagged as unused, even under `--production`.
- **Entry points from `package.json` & Vitest 5.1.2:** Automatically seeded `packages/runtime/src/cli/main.ts` (`bin`), `packages/runtime/src/index.ts` (`exports`), `packages/conformance/src/ledger.ts` and `scripts/spec-requirements.mjs` (`scripts`), and all 25 test files (`bun` plugin, active because `@types/bun` is in `devDependencies`). Also statically traced `new URL("../../scripts/store-probe.ts", import.meta.url)` in `packages/runtime/test/store/threads.test.ts:275`, so `store-probe.ts` was recognized as used automatically.
- **Effect v4 (`effect@4.1.5`):** Parsed cleanly, detected `effect`, and activated all three built-in Effect detectors (`unused-effect-layer`, `unused-tagged-error`, `unproduced-catch-tag`).
- **`--type-aware` companion (`fallow-type-aware@3.49.0`):** Worked out of the box against Spindle's `tsconfig.json` in 0.47–0.77s.

### Needed Configuration

- **Standalone probe and maintainer scripts** (`packages/runtime/scripts/{hook,queue,step}-probe.ts`, `scripts/seed-ledger.mjs`, `packages/conformance/fixtures/generate-large.mjs`): Flagged as `unused_files` because they are not listed in `package.json` `scripts` (and `queue-probe.ts` is referenced via a `source(...)` wrapper helper in `test/cli/processes.ts:11` rather than a direct `new URL(..., import.meta.url)` literal). Solved via `supportEntry`.
- **Conformance fixtures loaded by path** (`packages/conformance/fixtures/**`): The `vitest` plugin seeded 336 `.ts`/`.js` fixture files as entry points, leaving 2 `.mjs` fixtures (`invalid/duplicate-name/.../relay.mjs` and `queue/shift-clock.mjs`) flagged as `unused_files`, while letting fixtures pollute `dupes` and `health`. **Crucial gotcha discovered by testing:** putting `packages/conformance/fixtures/**` in `ignorePatterns` causes a **false positive `unused-dependency`** on `"spindle-runtime"` in `packages/conformance/package.json`, because 3 fixture files (`hello-world/.../spindle_test.ts`, `hooks/.../lane.ts`, `step-loop/.../lane.ts`) are the only files in `packages/conformance` that import `openaiCompatible` from `"spindle-runtime"`. Putting fixtures in `dynamicallyLoaded` (and excluding them only in `duplicates.ignore` and `health.ignore`) solves both problems cleanly.
- **Effect's `export const layer` idiom:** `duplicate-exports` flagged `layer` in `ThreadSupervisor.ts` and `sqlite.ts`. Solved by `"duplicate-exports": "off"`.
- **Compile-time contract check (`Platform.ts:33 Implementations`):** Flagged as `unused-type` (and `private-type-leak` under `--type-aware`). Solved via `ignoreExports`.
- **Static-estimated CRAP scores (`health`):** Without coverage data, Fallow assumes 0% test coverage for scripts and path-loaded fixtures, causing `CC^2 * (1 - 0)^3 + CC >= 30` to trigger at `CC = 5` (flagging 5-line functions like `median` and `classify`). Solved by `"complexity-crap": "off"`.
- **`unused-class-members` without `--type-aware`:** Syntactic mode cannot see that `ScriptedProvider` implements `@standardagents/spec`'s `LLMProviderInterface`, producing 3/3 false positives. Solved either by `"unused-class-members": "off"` or by running `--type-aware`.

### Does Not Work / Structural Limits

- **No dead-code detection for object methods or object properties:** Cannot detect unused methods on an Effect `Context.Service` interface/implementation (e.g. `ThreadStore.appendMessages`) or unread fields on returned objects (e.g. `Delivery.elsewhere`), even with `--type-aware`.
- **`fallow flags` is unusable on Spindle:** 100% false positives because its SDK heuristic matches Standard Agents' `state.getValue("...")` key-value API.
- **Short helper duplication:** Default `dupes` (`minTokens: 50`, `minLines: 5`) will not catch 1–3 line copy-pasted predicates like `isRecord` or `isCount`; lowering thresholds to `minTokens: 20, minLines: 2` catches `isRecord` but explodes total clone groups from 52 to 629.
- **Oversized files are unchecked by default:** `health.maxFileLines` defaults to `0` (disabled) until explicitly set.

---

## 4. What It Finds Here (Defaults, Verified Samples, and Review Comparison)

### Summary of Default Runs (`38c421c`, zero config, cold `--no-cache`)

| Analysis | Command | Time | Total findings | Sample read | Verified right | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Dead code (syntactic) | `fallow dead-code` | 84 ms | **44** | 44 / 44 | **32 / 44 (73%)** | 23/23 unused exports, 6/7 unused types, 2/2 cycles, 1/2 dup exports; 0/7 unused files, 0/3 class members |
| Dead code (`--type-aware`) | `fallow dead-code --type-aware` | 768 ms | **51** | 51 / 51 | **41 / 51 (80%)** | Eliminates all 3 false class members; adds 10 advisory `private-type-leaks` (9/10 accurate, 1 intentional trick) |
| Duplication (`mild` default) | `fallow dupes` | ~24 ms | **52** clone groups (872 lines, 3.84%) | 15 / 52 | **11 / 15 (73%)** actionable *(15/15 real text matches)* | 47/52 are in conformance scenarios/fixtures; only 3 touch `packages/runtime/src/` |
| Health / complexity | `fallow health` | ~210 ms | **69** functions *(score 82.9 / B; 116 large fns; 63 hotspots; 34 targets)* | 14 / 69 | **10 / 14 (71%)** | 7/7 cyclomatic/cognitive right; 39/69 are `crap`-only (4/7 sampled are 5–17 line false positives from 0% estimated coverage) |
| Architecture | `fallow architecture` | ~84 ms | **2** cycles | 2 / 2 | **2 / 2 (100%)** | Real value cycles in `registry/`; boundaries & rule packs inactive without config |
| Feature flags (opt-in) | `fallow flags` | 86 ms | **11** | 11 / 11 | **0 / 11 (0%)** | All 11 are false positives on `state.getValue("...")` KV calls in conformance scenarios |
| Security (opt-in) | `fallow security` | 152 ms | **6** | 6 / 6 | **0 / 6 (0%)** real bugs | 4 local CLI `fs.readFileSync`, 1 non-crypto SHA-1 req ID hash, 1 caller-configured provider `fetch` |
| Styling (opt-in) | `fallow health --css` | ~210 ms | **0** CSS findings | — | — | No CSS in repository |
| Auto-fix preview | `fallow fix --dry-run` | ~90 ms | **24** edits | 24 / 24 | **23 / 24 (96%)** | 23 safe `remove_export` edits; 1 over-broad `.fallowrc.json` `ignoreExports: ["*"]` proposal |
| Mutation plan (opt-in) | `fallow mutation --plan` | 239 ms | **0** (clean HEAD) | — | — | Detected Vitest 5.1.2 as supported; defaults to changed files |

*(Bare `fallow` runs dead-code + dupes + health together in **361 ms** cold.)*

### Detailed Verification of Samples

**Dead code (all 44 default findings + 10 `--type-aware` private type leaks read in source):**

- **Unused files (7 -> 0/7 real dead code):** `packages/conformance/fixtures/generate-large.mjs`, `packages/conformance/fixtures/invalid/duplicate-name/agents/agents/relay.mjs`, `packages/conformance/fixtures/queue/shift-clock.mjs`, `packages/runtime/scripts/hook-probe.ts`, `queue-probe.ts`, `step-probe.ts`, and `scripts/seed-ledger.mjs`. All seven are either manual scripts documented in `README.md`/`docs/plans/m1-core-loop.md` or dynamic test fixtures loaded by path.
- **Unused exports (23 -> 23/23 genuinely unimported):** Every one of the 23 (`cli/validate.ts`: `IssuesFound`, `formatText`, `formatJson`; `execution/ThreadSupervisor.ts`: `InvalidOption`; `execution/call.ts`: `ProviderFailure`, `ResponseRejected`, `applyChunk`; `execution/hooks.ts`: `POSITIONS`; `execution/redact.ts`: `REDACTED`; `execution/run-status.ts`: `IDLE_REASONS`, `FAILED_REASONS`; `execution/step.ts`: `DEFAULT_RETRIES`, `DEFAULT_STEP_CAP`; `execution/thread-state.ts`: `ExecutionEnded`, `SecretInArguments`, `InvalidArguments`; `execution/trace.ts`: `PHASES`; `providers/script.ts`: `Script`; `registry/Registry.ts`: `SPINDLE_ISSUE_CODES`, `ISSUE_CODES`; `store/schema.ts`: `maxJsonDepth`; `test/cli/chat-process.ts`: `launch`; `test/cli/processes.ts`: `fixture`) is referenced inside its own file and imported by zero other files. None are re-exported from `packages/runtime/src/index.ts`. (Four `Data.TaggedError` classes have their `_tag` string checked in `step.ts` or conformance tests, but the class symbol itself is never imported.)
- **Unused types (7 -> 6/7 real, 1 false positive):** `ThreadStore.ts` (`NewThread`, `IdentifiedMessage`, `Admitted`, `WriteRefused`, `InsertOptions`) and `test/cli/processes.ts:162` (`Row`) are unimported outside their files. `packages/runtime/src/platform/Platform.ts:33` (`Implementations`) is an intentional compile-time assignability assertion ensuring `node.ts` and `bun.ts` satisfy `Platform`; deleting it would remove that check.
- **Unused class members (3 -> 0/3 real without `--type-aware`):** `ScriptedProvider.specificationVersion`, `.stream`, and `.generate` in `packages/conformance/src/ScriptedProvider.ts` implement `LLMProviderInterface` from `@standardagents/spec`. Adding `--type-aware` resolved the interface contract and dropped all 3.
- **Duplicate exports (2 -> 1/2 useful, 1 false positive):** `fixture` in `test/cli/chat-process.ts:12` and `test/cli/processes.ts:12` reflects real test-harness duplication. `layer` in `execution/ThreadSupervisor.ts:116` and `store/sqlite.ts:103` is standard Effect convention and a false positive.
- **Circular dependencies (2 -> 2/2 real runtime cycles):** `Registry.ts:3` imports `loadDirectory` from `load-directory.ts`, which imports runtime values (`importFile`, `KINDS`, `LoadError`, `PLURAL`, `reportDefects`) from `Registry.ts:2`. `Registry.ts:4` imports `loadPackages` from `load-packages.ts`, which imports runtime values (`describeCause`, `fieldIssues`, `importFile`, `KINDS`, `LoadError`, `PLURAL`, `reportDefects`) from `Registry.ts:3-14`.
- **Private type leaks (`--type-aware`, 10 -> 9/10 technically accurate, 1 intentional trick):** Correctly flags `ModelResponse` (`Finish`), `POSITIONS` (`Row`), `runHooks` (`Vetoes`), `TRANSITIONS` (`EventType`), `requestBody` (`Json`), and `schema.ts`'s `text`/`ThreadRow`/`MessageRow`/`callsIn` (`Text`). `Platform.ts:Implementations` (`Implements`) is the intentional compile-time assertion. These are currently internal modules (not re-exported by `index.ts`), so they are low urgency today, though they will matter if `packages/runtime` starts emitting `.d.ts` files (`pr-2.md` S5).

**Duplication (15 sampled clone groups out of 52 read in source):**

- **Actionable (11/15):** `chat.ts:351-356` vs `run.ts:187-192` (validation error printing); `run.ts:230-235` vs `status.ts:33-38` (top-level `catchCause` handler); `load-packages.ts:19-25` vs `validate.ts:69-74` (`isStringArray` helper block); `store-probe.ts:60-66` vs `test/store/contract.test.ts` (duplicated fixture helpers); `step-probe.ts:39-42` vs `store-probe.ts:175-179` (`median` + probe boilerplate); `history-snapshot.ts` (18 lines repeated 4x); `queue/secrets.ts` (14 lines repeated 3x); `queue/delivery.ts` (14-line gated provider setup repeated 2x); `ownership/call-history.ts:147-155` vs `queue/termination.ts:263-271` (identical `forceRecover` block); `step-loop/tool-results.ts:320-341` vs `turn-assembly.ts:502-523` (22-line `chart` attachment fixture); `store-probe.ts:343-349` vs `:357-363` (`withStore` setup).
- **Benign boilerplate (4/15):** `fixtures/invalid/.../index.js` (4 packed fixture stubs that must stay self-contained); `integrity.ts` / `thread-state.ts` / `tool-results.ts` (generic 2-step `ScriptedProvider` + `using(...)`); 5-line trailing assertion match in `injection.ts`/`secrets.ts`; probe subcommand framing.

**Health / complexity (14 sampled functions out of 69 read in source):**

- **Real complexity targets (10/14):** All 7 sampled cyclomatic/cognitive findings are clearly real: `validate.ts:282 checkPrompt` (cyc 52, cog 86, 113 lines), `call.ts:159` incremental JSON parser arrow (cyc 41, cog 66), `openai-compatible.ts:316 streamChunks` (cyc 40, cog 81, 84 lines), `load-packages.ts:136 loadPackage` (cyc 40, cog 49, 170 lines), `step.ts:345 loop` (cyc 32, cog 64, 364 lines), `hooks.ts:467 runHooks` (cyc 21, cog 34), `sqlite.ts:297` `insertMessage` transaction body (cyc 20, cog 21). Three of the 7 sampled `crap`-only findings are also legitimate hand-rolled switch/validator targets (`call.ts:100 applyChunk` cyc 19; `hooks.ts:201 isLLMMessage` cyc 15; `hooks.ts:114 isMessage` cyc 13).
- **Noise from static-estimated CRAP (4/14):** `fixtures/queue/agents/tools/hold.ts:11 execute` (17-line test fixture marked `critical` because static coverage sees 0%), `tools.ts:57 isToolResult` (9-line predicate, cog 4), `step-probe.ts:39 median` (5-line math helper, cyc 5, cog 4), and `scripts/spec-requirements.mjs:59 classify` (5-line regex helper, cyc 5, cog 5). Overall, 39 of the 69 default health findings failed on `crap` alone.

**Flags (all 11) and Security (all 6):**

- All 11 `flags` findings are `state.getValue("...")` calls on Standard Agents' thread KV store (`created`, `from_tool`, `kept`, `anything`, `color`, `bookings`, `note`).
- All 6 `security` findings are benign: 4 `fs.readFileSync` calls in local dev/CI scripts (`ledger.ts:124`, `spec-requirements.mjs:86,168`, `step-probe.ts:49`), 1 non-cryptographic `createHash("sha1")` requirement-ID fingerprint (`spec-requirements.mjs:32`), and 1 `fetch(input, init)` in `openai-compatible.ts:446` where caller-supplied `baseUrl` is the feature.

### Comparison Against the Seven Quality Reviews (`pr-2.md`–`pr-10.md`)

**What Fallow caught that the reviewers also found:**

- **Complexity hotspots and oversized functions:** Fallow's top 15 hotspots (`step.ts`, `sqlite.ts`, `hooks.ts`, `ThreadSupervisor.ts`, `assemble.ts`, `tools.ts`, `thread-state.ts`, `messages.ts`, `load-packages.ts`, `schema.ts`, `run.ts`, `validate.ts`, `spec-requirements.mjs`) and top complexity findings (`checkPrompt`, `validate` 490 lines, `loadPackage` 170 lines, `streamChunks`, `call.ts`, `step.ts:loop` 364 lines, `runHooks`, `converse` 158 lines) match almost the exact structural problem list across PRs 2, 4, 5, 6, 7, 8, and 10.
- **Part of the CLI and probe duplication:** Default `dupes` caught validation-error printing (`chat.ts:351-356` vs `run.ts:187-192`), `catchCause` (`run.ts:230-235` vs `status.ts:33-38`), `store-probe.ts` vs `contract.test.ts`, `step-probe.ts` vs `store-probe.ts`, and `load-packages.ts` vs `validate.ts`. Switching `dupes` to `mode: "semantic"` also caught `loadScript`/`readScript` (`chat.ts:75-80` vs `run.ts:35-40`), `run.ts` vs `validate.ts`, and `run.ts` vs `send.ts`. `duplicate-exports` also hinted at the `chat-process.ts`/`processes.ts` harness copy via `fixture`.

**What the reviewers found that Fallow missed:**

- **`isRecord` copied 13 times** (plus `isCount` x4, `nowMicros` x2, `noInvoke` x2, `plural` x2, `describe` x5+): 1–4 line helpers fall below `dupes`'s 50-token / 5-line floor.
- **Two of the four `chat.ts` / `run.ts` copies** (redacting `Console` + `Logger`, and `chat.ts`'s slightly modified `catchCause`/bootstrap) and the bulk of `chat-process.ts` vs `processes.ts`.
- **Dead store method `ThreadStore.appendMessages` (`pr-4.md` S5):** It is a property on an Effect `Context.Service` object (and called by store tests), so export-level reachability does not see it.
- **Unread field `Delivery.elsewhere` (`pr-10.md`, `ThreadSupervisor.ts:25`):** Object literal field, not a module export or class member.
- **Files over 1,000 lines:** `health.maxFileLines` is `0` (off) by default. (Note: by commit `38c421c`, `m1/9-test-harness` had already split the 1,000+ line conformance files; the largest files at `38c421c` are `validate.test.ts` at 802 lines and `step.ts` at 778 lines.)
- **All Effect-architecture, concurrency, and algorithmic issues:** `converse`'s 7 shared mutable variables, `O(N^2)` per-step history scans, `positions` `WeakMap` leak, `PreventSchedulerYield` spin, `Effect.orDie`, `unknown` error channels, shotgun parsing.

**What Fallow found that all seven reviewers missed:**

1. **Two runtime circular dependencies in `packages/runtime/src/registry/`:** `Registry.ts <-> load-directory.ts` and `Registry.ts <-> load-packages.ts`. Both are mutual value imports (not `import type`), and none of the seven reviews flagged them.
2. **29 genuinely over-exported internal symbols and types** (23 value/class/const exports + 6 types) across `packages/runtime/src/` and `test/cli/`.
3. **9 accurate private type leaks** (with `--type-aware`), which would surface as declaration-emit problems once `packages/runtime` publishes `.d.ts` files (`pr-2.md` S5).

---

## 5. Overlap With Existing Tools

| Tool in repo | Time (`38c421c`) | Scope | Overlap with Fallow | What Fallow adds / where they conflict |
| --- | --- | --- | --- | --- |
| **Biome** (`2.6.9`) | 1.23 s | Single-file format, lint (`noUnusedVariables`, `noUnusedImports`), `#platform` import & global restrictions | Minimal. Biome's optional `noExcessiveCognitiveComplexity` (currently off) would overlap with `fallow health`. Biome's `noRestrictedImports` overlaps with Fallow's `boundaries`. | Fallow adds whole-repo dead exports/files/deps, circular dependencies, cross-file duplication, git-churn hotspots, and PR-diff gating (`audit`). Keep Fallow's `boundaries` **off**: Biome already enforces `#platform` plus `noRestrictedGlobals` (`process`, `Bun`, `Buffer`), which Fallow cannot check. |
| **TypeScript 7** (`tsc`) | *(part of typecheck)* | Type safety; optional `--noUnusedLocals` / `--noUnusedParameters` (currently off; tested at 0 hits on `38c421c`) | Almost none. `tsc` checks only unexported locals/params within one file. (If `declaration: true` is added later, `tsc` will also catch private type leaks in public exports.) | `tsc` never reports unused module exports, unused files, unused `package.json` dependencies, circular imports, duplication, or complexity. |
| **Effect Language Service** (`@effect/tsgo@0.73.7`) | 1.17 s | Effect-specific type & idiom diagnostics (`floatingEffect`, `unknownInEffectCatch`, `tryCatchInEffectGen`, `missingConcurrencyOption`, etc.) | Nearly zero. Fallow's 3 Effect dead-code rules (`unused-effect-layer`, `unused-tagged-error`, `unproduced-catch-tag`) are cross-file reachability checks that `@effect/tsgo` does not perform. | **One contradiction:** Fallow's `duplicate-exports` flags `export const layer` across Effect service modules. Turn `duplicate-exports` off in `.fallowrc.json`. |
| **Requirements & ledger scripts** (`pnpm requirements`, `pnpm ledger`) | <1 s | Spec requirement extraction and Vitest-to-ledger coverage mapping | Zero overlap. | Fallow auto-detects both scripts from `package.json` `scripts`. |

---

## 6. Recommended Configuration, Placement, and Runtime Cost

### Exact Recommended `.fallowrc.json`

Tested directly against `/tmp/fallow-scratch/repo` (`fallow doctor` passes with 0 warnings; `dead-code` drops from 44 findings / 73% precision to **31 findings / 100% real**; `health` drops from 69 findings to **30 real cyclomatic/cognitive targets**; `dupes` reports **24 semantic clone groups** in non-test/non-scenario code; `workspace_diagnostics` is empty).

```json
{
  "$schema": "./node_modules/fallow/schema.json",
  "supportEntry": [
    "packages/runtime/scripts/*.ts",
    "packages/conformance/fixtures/generate-large.mjs",
    "scripts/seed-ledger.mjs"
  ],
  "dynamicallyLoaded": [
    "packages/conformance/fixtures/**/*.{ts,mts,js,mjs}"
  ],
  "ignoreExports": [
    {
      "file": "packages/runtime/src/platform/Platform.ts",
      "exports": ["Implementations"]
    }
  ],
  "rules": {
    "duplicate-exports": "off",
    "unused-class-members": "off",
    "complexity-crap": "off",
    "boundary-violation": "off",
    "policy-violation": "off"
  },
  "duplicates": {
    "mode": "semantic",
    "minTokens": 50,
    "minLines": 5,
    "minOccurrences": 2,
    "ignore": [
      "packages/conformance/fixtures/**",
      "packages/conformance/src/scenarios/**",
      "packages/runtime/test/**"
    ]
  },
  "health": {
    "maxCyclomatic": 20,
    "maxCognitive": 15,
    "maxUnitSize": 60,
    "maxFileLines": 800,
    "ignore": [
      "packages/conformance/fixtures/**",
      "packages/runtime/test/**",
      "packages/conformance/test/**"
    ]
  }
}
```

### Reason for Every Setting and Entry-Point Handling

- **`$schema`:** Points to the locally installed schema so editors validate the file offline without network fetches.
- **Auto-detected entry points (no config needed):**
  - **CLI:** `packages/runtime/src/cli/main.ts` (auto-detected from `packages/runtime/package.json` `bin`).
  - **Package exports:** `packages/runtime/src/index.ts` (auto-detected from `packages/runtime/package.json` `exports`).
  - **Test files:** `packages/*/test/**/*.test.ts` (auto-detected by the active `bun`/`vitest` plugins).
  - **Package scripts:** `scripts/spec-requirements.mjs` and `packages/conformance/src/ledger.ts` (auto-detected from root `package.json` `scripts`).
  - **The two `#platform` files (`node.ts` and `bun.ts`):** No config needed. Fallow automatically resolves both branches of `"#platform"` in `packages/runtime/package.json` `imports` and marks all exports of both files as used by every `#platform` importer. (Tested both with and without explicit `resolve.conditions` — both files stay reachable either way.)
- **`supportEntry`:** Marks the manual probe and maintainer scripts (`packages/runtime/scripts/*.ts`, `generate-large.mjs`, `scripts/seed-ledger.mjs`) as non-production entry points. Unlike `entry`, `supportEntry` keeps them out of `unused_files` during normal runs while excluding them under `--production` so a probe script's imports cannot mask dead production code.
- **`dynamicallyLoaded`:** Marks all conformance fixture files loaded by path at runtime as reachable entry points. Using `dynamicallyLoaded` instead of `ignorePatterns` is essential: three fixtures import `openaiCompatible` from `spindle-runtime`, so putting fixtures in `ignorePatterns` causes a false `unused-dependency` error on `packages/conformance/package.json`.
- **`ignoreExports` (`Platform.ts` -> `Implementations`):** Preserves the intentional compile-time contract assertion checking `node.ts` and `bun.ts` against `Platform`.
- **`rules.duplicate-exports: "off"`:** Avoids contradicting Effect's convention of exporting `layer` from each service module.
- **`rules.unused-class-members: "off"`:** Avoids the 3 false positives on `ScriptedProvider implements LLMProviderInterface` without paying for the ~30 MB `fallow-type-aware` companion package. *(Alternative: install `fallow-type-aware@3.49.0`, set `"typeAware": { "enabled": true }`, and leave `unused-class-members` on — adds ~0.4–0.7s per run and also enables `private-type-leaks`.)*
- **`rules.complexity-crap: "off"`:** Disables static-estimated CRAP scores (which flag 5-line helpers at `CC = 5` whenever coverage is estimated as 0%). Re-enable only if Vitest Istanbul coverage is wired into `health.coverage`.
- **`rules.boundary-violation: "off"` & `rules.policy-violation: "off"`:** Silences the two `workspace_diagnostics` reminders; Biome already enforces the `#platform` boundary (imports and runtime globals).
- **`duplicates` (`mode: "semantic"`, `minTokens: 50`, `minLines: 5`, `minOccurrences: 2`, ignoring fixtures/scenarios/tests):** `semantic` mode catches renamed copies like `cli/run.ts:loadScript` vs `cli/chat.ts:readScript` that default `mild` mode misses. Ignoring fixtures, conformance scenarios, and test files keeps the report focused on production and script code (24 clone groups, 3.09% duplication) instead of 47 test-scenario setup matches.
- **`health` (`maxCyclomatic: 20`, `maxCognitive: 15`, `maxUnitSize: 60`, `maxFileLines: 800`, ignoring fixtures/tests):** Keeps Fallow's standard complexity thresholds, adds an 800-line file ceiling to catch files creeping back toward 1,000 lines (0 violations today on `src/` where the largest file is `step.ts` at 778 lines), and excludes fixtures and unit tests from complexity scoring.

### Where to Run It and Cost in Seconds

| Command (with recommended `.fallowrc.json`) | Cold (`--no-cache`) | Warm cache |
| --- | --- | --- |
| `fallow dead-code` | **0.09 s** | ~0.06 s |
| `fallow health` | **0.21 s** | ~0.08 s |
| `fallow` (combined: dead-code + dupes + health) | **0.31 s** | **0.13 s** |
| `fallow dead-code --type-aware` (optional companion) | **0.47 s** | — |
| `fallow audit --base origin/m1/7-chat` (97 changed files) | **0.77 s** | — |

**Recommended execution placement:**

1. **Run in CI as a dedicated job (not inside the 3-runtime matrix, and not blocking `pnpm check` yet).** Fallow is a native Rust binary whose analysis does not depend on Node 22 vs Node 24 vs Bun, so running it once on Ubuntu in `.github/workflows/ci.yml` costs under 1 second. Run `DO_NOT_TRACK=1 FALLOW_UPDATE_CHECK=off pnpm exec fallow audit --base "origin/${GITHUB_BASE_REF:-main}"` in report-only mode while the current restructuring stack lands, then remove report-only so PRs cannot introduce *new* unused exports, cycles, high-complexity functions, or duplicated blocks.
2. **Optional graduation into `pnpm check` later:** Once the 31 existing dead-code findings (23 unused exports, 6 unused types, 2 registry cycles) are resolved during restructuring, `fallow dead-code` alone (~0.09s) is fast and high-signal enough to add to `pnpm check` as a blocking gate if desired. Keep `fallow health` and `fallow dupes` in PR `audit` / on-demand scripts (`pnpm fallow`) rather than blocking `pnpm check` on pre-existing complexity.
