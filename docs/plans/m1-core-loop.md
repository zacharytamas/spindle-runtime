# Spindle milestone 1 plan

Spindle is a self-hosted runtime for Standard Agent Specification 0.2.0, written in TypeScript on Effect v4.
Milestone 1 ends when `spindle run` and `spindle chat` execute a prompt side against a human side from an `agents/` directory, with every message durable in SQLite.
The work is for people who want to run Standard Agents outside Standard Agents Hosting, and for the engineers who maintain Spindle after them.
The program enforces one rule. A requirement counts as implemented only when the ledger maps it to a passing test.
Core code imports Effect services only. The Node module and the Bun module under `src/platform/` supply the implementations.
The PR ids in order are M1-1, M1-2, M1-3, M1-4, M1-5, M1-6, and M1-7.
Later milestones get their own plan files. Appendix E lists them.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `<pstack>/skills/poteto-mode/playbooks/autopilot-stack.md`, where `<pstack>` is `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.34`. Owners build and verify. The root chains the PRs into one stack. The operator reviews and lands the stack bottom-up. The operator plans a review of code quality and file structure once the whole stack is built. Nothing lands and no later milestone starts before that review. M1-2, M1-4, and M1-7 are review-gated and stop at merge-ready.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

Spindle has no browser surface. A live lane drives the `spindle` command or a probe script through the shell and saves a terminal transcript as a `.txt` file in place of a screenshot.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these at program start. Re-read them at every tick.
  - [ ] `git show origin/main:docs/plans/m1-core-loop.md`, after the operator lands this plan on `main`. Before that, read the file on the `plan/v1` branch.
  - [ ] `<pstack>/skills/poteto-mode/playbooks/autopilot-stack.md` and `<pstack>/skills/poteto-mode/playbooks/autopilot-full.md`
  - [ ] `<pstack>/skills/swarm/SKILL.md`
  - [ ] `<pstack>/skills/poteto-mode/playbooks/opening-a-pr.md` and `<pstack>/skills/poteto-mode/playbooks/shipping.md`
  - [ ] `<pstack>/skills/benchmark-checklist/SKILL.md`, before any perf box
  - [ ] `<pstack>/docs/harness/claude-code.md`
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt. "Re-read the execution playbook from the pstack plugin folder. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Spawn owners

- [ ] Spawn one owner per PR with `delegate_task`, `isolation` set to `worktree`, and the full lifecycle that `autopilot-stack.md` names. The brief tells the owner to read `<pstack>/skills/poteto-mode/SKILL.md` first.
- [ ] Run every owner on GPT-6.2 Astra at `high` reasoning effort. The operator moved implementation to it on 2026-11-26. Before that, Claude Opus 5.5 built M1-1 to M1-6.
- [ ] Use Claude Fable 5.2 for the root and for every review that reads and judges. Those are spec briefs, failure-mode briefs, design notes, audits, and re-checks. GPT-6.2 Astra did those reviews before 2026-11-26.
- [ ] Use no Grok model for any role. The operator allows one only with a careful review of its work.
- [ ] Put these three rules in every owner brief.
  - [ ] Clean room. Read the spec text and `@standardagents/spec` only. Never open a file inside `@standardagents/builder`, `@standardagents/cloudflare`, or any other proprietary Standard Agents package. Never install `@standardagents/builder`.
  - [ ] Effect v4 from the installed package. Read the type declarations under `node_modules/effect` and `node_modules/@effect/*` before you write a call. Do not write Effect v3 names from memory. `@effect/platform` and `@effect/sql` stopped at 0.x and are not dependencies.
  - [ ] Spec text decides behavior and `@standardagents/spec` decides signatures. Record each disagreement in `packages/conformance/DIVERGENCES.md`.
- [ ] Before an owner starts M1-4, M1-5, or M1-6, run a spec brief on GPT-6.2 Astra and give the owner its path. The brief reads the PR's spec pages and its plan section. It lists each place where the plan contradicts the spec, the scenarios the PR must pass with their spec lines, the legal inputs that must work and the illegal inputs that must fail, and each requirement that has no entry in `requirements.json`. The first three PRs each passed their own tests and then failed an Astra audit on points the spec text already stated, so the brief moves that reading in front of the build.
- [ ] Follow this dependency graph. Each owner branches from its parent's branch.
  - [ ] M1-1 is first and branches from `main`.
  - [ ] M1-2 and M1-3 are independent of each other. Both branch from M1-1.
  - [ ] M1-4 after M1-2 and M1-3. The root chains M1-3 onto M1-2 first.
  - [ ] M1-5 after M1-4.
  - [ ] M1-6 after M1-5.
  - [ ] M1-7 after M1-6.
- [ ] Hold the file boundaries.
  - [ ] M1-2 touches only `packages/runtime/src/registry/**`, `packages/runtime/src/cli/**`, and `packages/conformance/fixtures/**`.
  - [ ] M1-3 touches only `packages/runtime/src/store/**` and `packages/runtime/src/platform/**`.
  - [ ] M1-7 touches only `packages/runtime/src/cli/chat.ts`, `packages/runtime/src/execution/ThreadSupervisor.ts`, and `packages/runtime/test/cli/**`.
  - [ ] Every PR may edit `packages/conformance/ledger.json`. Each PR edits only the entries for its own requirement ids.
- [ ] Hold the review gate. M1-2, M1-4, and M1-7 add a command that a person types. They wait for the operator's review in chat with a transcript and a terminal video before merge.

### PR mechanics, for every PR

- [ ] Use `gh` for every PR operation. `command -v origin` finds no Origin CLI on this machine.
- [ ] Open the PR ready, never draft, per `opening-a-pr.md`. Use `gh pr create --base <parent-branch>`. A stack child targets its parent branch.
- [ ] Run `pnpm check` once before the PR-facing push. Push with hooks on.
- [ ] Apply `<pstack>/skills/unslop/SKILL.md` to every prose file and `<pstack>/skills/no-comments/SKILL.md` to the diff before review. The `cursor-team-kit` plugin is not installed, so `/deslop` is skipped in Claude Code.
- [ ] Triage every automated review comment per `<pstack>/skills/poteto-mode/references/bugbot-triage.md`. This repository has no Bugbot check today.
- [ ] Keep the merge base that the root assigned. Only the root rebases or retargets a link in the stack.
- [ ] Add an entry to `packages/conformance/requirements.extra.json` for each requirement with no keyword that you find in the sections your PR implements. Quote the spec text verbatim, then run `node scripts/spec-requirements.mjs --refresh` and `node scripts/seed-ledger.mjs`.

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head. Run each full swarm per `<pstack>/skills/swarm/SKILL.md`. One gates lane runs `pnpm check` on Node and on Bun. The ten live lanes come from the PR's **Verify, live** block. The perf lane comes from its **Verify, perf** block. Two audit lanes read the diff and the receipts and distrust the PR body. One audit lane checks the diff against the spec text for the ledger entries the PR marks `covered`. The other audit lane checks the clean-room rule and the platform import rule. The gates lane, the live lanes, and the perf lane run on Claude Sonnet 5.5. The spec audit lane runs on Claude Fable 5.2. The clean-room audit lane runs on Gemini 4 Neon. Every lane brief carries the three owner-brief rules, because a lane on another provider loads no pstack skill.
- [ ] Until the operator's review of the built stack, run the full swarm on M1-1 only. For each later PR, one Claude Sonnet 5.5 verifier runs the gates and the ten live lanes in sequence in one worktree, and the spec audit lane runs beside it. The full swarm for M1-2 through M1-7 runs after the review, at the reviewed head.
- [ ] Clean only when every lane is `PASS`. A lane that cannot run reports `BLOCKED`, and `BLOCKED` is not `PASS`. A finding that blocks goes back to the owner, including one that a lane filed as a note. A finding blocks when stored data is lost or changed, a secret leaks, a tool call has no result or a result has no call, a tool runs twice, two executions of one thread run at once, or a thread cannot continue. Every other finding goes to `docs/plans/trail/m1-followups.md`. A failed or blocked verification lane still blocks. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `shipping.md`.
- [ ] The owner reports STACK-READY. The root appends the PR to the stack in dependency order with `gh pr edit <pr> --base <parent-branch>`. The operator lands the stack bottom-up.

### Boot recipe, for every live lane

Each live lane runs in its own git worktree at the PR head. The `control-cli` skill is not installed, so each lane drives the command line through the shell.

- [ ] `git fetch origin <head-branch> && git worktree add /tmp/swarm-<pr-id>/worker-<n>/tree <head SHA>`.
- [ ] Run `pnpm install --frozen-lockfile && pnpm build` in the worktree. Wait for exit code 0.
- [ ] Give each lane its own database file at `/tmp/swarm-<pr-id>/worker-<n>/spindle.db`. Never share a database file between lanes.
- [ ] Run the lane's commands exactly as written. Read state only through `spindle` output, the probe script, or `sqlite3 <db> "<select>"`.
- [ ] Save every transcript to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.txt` with the command, the exit code, and the full output. Return the paths with the report.

## Set up the workspace and the requirement ledger (M1-1)

The ledger is a JSON map from requirement id to `{ status, milestone, tests, reason }`. The status is one of `covered`, `partial`, `planned`, `deferred`, and `not-testable`. A `partial` entry names a passing test for the part of a statement that its milestone implements, and its reason says what a later milestone still owes. A requirement id is the page name plus a hash of the section and the statement text, so a spec edit shows up as one removed id and one added id.

**Depends on.** None.

**Files.**

- [x] Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, and `.github/workflows/ci.yml`.
- [x] Create `packages/runtime/package.json` with the `spindle` bin and an `imports` entry for `#platform` that has a `bun` condition and a `default` condition.
- [x] Create `packages/runtime/src/platform/node.ts`, `packages/runtime/src/platform/bun.ts`, and `packages/runtime/src/cli/main.ts`.
- [x] Create `packages/conformance/package.json`, `packages/conformance/spec.lock.json`, `packages/conformance/requirements.json`, `packages/conformance/ledger.json`, and `packages/conformance/src/ledger.ts`.
- [x] Edit `scripts/spec-requirements.mjs` so that it reads the spec commit from `spec.lock.json`, fetches the spec only under `--refresh`, and exits non-zero under `--check` when its output differs from `requirements.json`.
- [x] Create `AGENTS.md` with the three owner-brief rules, and symlink `CLAUDE.md` to it.
- [x] Create `LICENSE` with the MIT license text.
- [x] Edit `README.md`.

**Build.**

- [x] Add `effect`, `@effect/platform-node`, `@effect/platform-bun`, `@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, and `@standardagents/spec` to `packages/runtime`. Add `vitest` and `@effect/vitest` as dev dependencies. Pin every Effect package to the same exact version.
- [x] Name the packages `spindle-runtime` and `spindle-conformance`, and set `license` to `MIT` in both. The npm registry returned 404 for both names on 2026-11-25.
- [ ] Export one `PlatformLive` layer and one `runMain` function from each platform module. `node.ts` builds them from `NodeServices`, `NodeRuntime`, and the `SqliteClient` of `@effect/sql-sqlite-node`. `bun.ts` builds them from `BunServices`, `BunRuntime`, and the `SqliteClient` of `@effect/sql-sqlite-bun`.
- [x] Make `packages/runtime/src/cli/main.ts` import `PlatformLive` and `runMain` from `#platform` and print the package version, `SPEC_VERSION`, and the platform name for `spindle --version`.
- [x] Add a Biome `noRestrictedImports` rule. Only files under `packages/runtime/src/platform/` may import `@effect/platform-node`, `@effect/platform-bun`, `@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, a `node:` module, or a `bun:` module.
- [x] Settle how the test suite runs under Bun. Try `bun --bun vitest run` first. If the Vitest version that `@effect/vitest` requires does not run under Bun, run the platform contract tests with `bun test` and record the result in Appendix A.
- [x] Pin the spec at commit `f462a673297faed1f849ef1741ddda1e06b6c817` in `spec.lock.json` and generate `requirements.json`.
- [x] Write `packages/conformance/src/ledger.ts`. It fails when a requirement id has no ledger entry, when a `covered` entry names no test, when a named test does not exist, and when a ledger id is absent from `requirements.json`.
- [ ] Fill `ledger.json` with one entry per id. Mark every `specification:users` entry `deferred` with the reason that the page is a Draft. Mark every other entry `planned` with its milestone from Appendix E.
- [x] Add the `pnpm check` script. It runs Biome, `tsc --noEmit`, Vitest, the ledger check, and `scripts/spec-requirements.mjs --check`.
- [x] Run `pnpm check` in CI on Node 22, on Node 24, and on Bun.

**You see.**

- [x] `pnpm check` exits 0 and its last line reads `ledger ok, 777 requirements, 0 covered`.
- [x] `node scripts/spec-requirements.mjs --check` prints `606 RFC 2119 statements, 61 lowercase must or should statements, 110 curated statements with no keyword, 24 pages`.
- [x] `node packages/runtime/dist/cli/main.js --version` prints `platform node`, and `bun packages/runtime/dist/cli/main.js --version` prints `platform bun`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `packages/conformance/test/ledger.test.ts` gains one case for each of the four ledger failures. Run `pnpm vitest run packages/conformance/test/ledger.test.ts`.
- [ ] `packages/runtime/test/platform.test.ts` gains a case that opens an in-memory SQLite database through `PlatformLive` and reads back one row. Run it on Node and on Bun.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk holds only `README.md`, so record that trunk has no check command. At the head, clone fresh and run `pnpm install --frozen-lockfile && pnpm check`. Save `fresh-clone-check.txt`. Pass when the exit code is 0 and the output names the lint, typecheck, test, ledger, and requirements steps.
- [ ] Lane 2. Run `pnpm test` on the lowest Node version that `engines` allows. Save `node-minimum.txt`. Pass when every test passes and none is skipped.
- [ ] Lane 3. Run the test suite under Bun 1.4 with the command the PR documents. Save `bun-tests.txt`. Pass when every test passes and the output shows that Bun executed the tests.
- [ ] Lane 4. Run `node scripts/spec-requirements.mjs --refresh --check` with network access. Save `requirements-refresh.txt`. Pass when the count line matches the **You see** block and `git status --porcelain` prints nothing.
- [ ] Lane 5. Delete one entry from `ledger.json` and run `pnpm check`. Save `ledger-missing.txt`. Pass when the exit code is not 0 and the output names the deleted id.
- [ ] Lane 6. Set one entry to `covered` with an empty `tests` list and run `pnpm check`. Save `ledger-untested.txt`. Pass when the exit code is not 0 and the output names that id.
- [ ] Lane 7. Add a ledger entry whose id is not in `requirements.json` and run `pnpm check`. Save `ledger-stale.txt`. Pass when the exit code is not 0 and the output calls the id stale.
- [ ] Lane 8. Add `import "node:fs"` to `packages/runtime/src/cli/main.ts` and run `pnpm check`. Save `platform-import-rule.txt`. Pass when Biome fails and names the file and the import.
- [ ] Lane 9. Run `spindle --version` with Node and with Bun. Save `version-platforms.txt`. Pass when the Node run prints `platform node`, the Bun run prints `platform bun`, and both print `spec 0.2.0`.
- [ ] Lane 10. Disable the network and run `pnpm check` in an installed worktree. Save `offline-check.txt`. Pass when the exit code is 0.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `pnpm check` in an installed worktree. Trunk has no check command, so the diff-added work is the whole command and the end state is a green check.
- [ ] Probe. Run `pnpm check` five times on Node and five times on Bun, alternating the two, and take the median of each.
- [ ] Baseline. Record that trunk produces no value, then record the first head medians.
- [ ] Rule. The PR fails when either median is above 60 seconds.

**Review gate.** None. M1-1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root makes M1-1 the root of the stack and the operator lands the stack bottom-up.

## Load and validate definitions (M1-2)

The registry is a map from definition kind and qualified name to a lazy loader, plus the `PackageSignature` of each packed definition. One `resolve(kind, name, from)` function applies the visibility table from the Packaging page. No caller checks visibility on its own.

**Depends on.** M1-1.

**Files.**

- [x] Create `packages/runtime/src/registry/Registry.ts`, `load-directory.ts`, `load-packages.ts`, `resolve.ts`, and `validate.ts`.
- [x] Create `packages/runtime/src/cli/validate.ts`.
- [x] Create `packages/conformance/fixtures/agents-basic/`, `packed-a/`, `packed-b/`, and `scoped-pkg/`, and one fixture directory per invalid case under `packages/conformance/fixtures/invalid/`.

**Build.**

- [x] Define `Registry` as an Effect service. Its layer needs `FileSystem` and `Path` and nothing platform-specific.
- [x] Load unpacked definitions from the default exports of the files under `agents/agents`, `agents/prompts`, `agents/tools`, `agents/models`, `agents/hooks`, `agents/handlers`, and `agents/effects`. Import each `.ts` file directly. Node 22.22 and Bun both strip types on import.
- [x] Discover packed packages by the `standardagent` field in each `package.json` under `node_modules`, and under `agents/packed/`. Import each package, read `__meta`, and attach a `PackageSignature` to every definition at load time.
- [x] Implement `resolve` with `parseQualifiedName` and `isVisibleInNamespace` from `@standardagents/spec`, including scoped package ids.
- [x] Validate at load time. Call `validateAgentDefinition` from `@standardagents/spec`. Add the checks the spec text requires that the function does not cover, which the owner finds by reading Agents section 8, Handlers section 2, Subagents section 2.4, Prompts sections 2.4, 3.4, and 9, Models section 6, and Hooks section 1.2.
- [x] Add `spindle validate [dir]`. It prints one line per issue as code, severity, path, and message. It exits 1 when any issue has severity `error`. `--json` prints the issue list as JSON. `--list` prints every resolved qualified name by kind.

**You see.**

- [x] `spindle validate packages/conformance/fixtures/agents-basic` exits 0 and prints the count of agents, prompts, tools, models, hooks, handlers, and effects.
- [x] `spindle validate packages/conformance/fixtures/invalid/both-sides-human` exits 1 and prints one issue line with a code from `DEFINITION_ISSUE_CODES`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `packages/runtime/test/registry/resolve.test.ts` gains one case per cell of the visibility table and one case per qualified-name form. Run `pnpm vitest run packages/runtime/test/registry`.
- [x] `packages/runtime/test/registry/validate.test.ts` gains one case per invalid fixture. Each case asserts the issue code and the path.
- [x] The ledger entries for `distribution:packaging` and for the definition-time statements in `specification:agents`, `specification:handlers`, `specification:prompts`, `specification:models`, and `specification:hooks` change to `covered`. Run `pnpm check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. The parent branch has no `spindle validate`, so record that. At the head, run `spindle validate packages/conformance/fixtures/agents-basic`. Save `validate-basic.txt`. Pass when the exit code is 0 and every kind has a count.
- [ ] Lane 2. Validate an agent whose two sides are both human. Save `both-sides-human.txt`. Pass when the exit code is 1 and the issue names the agent file.
- [ ] Lane 3. Validate an agent side that sets both `prompt` and `handler`. Save `two-backings.txt`. Pass when the exit code is 1 and the issue path points at that side.
- [ ] Lane 4. Validate a prompt whose `tools` array names a handler. Save `handler-as-tool.txt`. Pass when the exit code is 1 and the issue names the handler.
- [ ] Lane 5. Validate a relationship with `as` set to `subagent_create`. Save `reserved-relationship.txt`. Pass when the exit code is 1 and the message lists the three reserved names.
- [ ] Lane 6. Validate two prompts that include each other. Save `circular-include.txt`. Pass when the exit code is 1 and the message names both prompts.
- [ ] Lane 7. Install `packed-a` and `packed-b`, which each hold an internal tool named `search`, and run `spindle validate --list`. Save `namespace-isolation.txt`. Pass when the exit code is 0 and the list shows `packed-a/search` and `packed-b/search` as separate entries.
- [ ] Lane 8. Validate a global prompt that names an internal tool of `packed-a`, then one that names an entry agent of `packed-a`. Save `visibility.txt`. Pass when the first run exits 1 with an unresolved-name issue and the second run exits 0.
- [ ] Lane 9. Validate a prompt that names `@scope/pkg/agent`. Save `scoped-name.txt`. Pass when `--list` shows package id `@scope/pkg` and name `agent`.
- [ ] Lane 10. Run `spindle validate --json` under Bun on a fixture with three different errors. Save `json-three-errors.txt`. Pass when the output parses as JSON and holds three issues, each with `code`, `severity`, `message`, and `path`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Wall time of `spindle validate` on a generated fixture with 200 definitions. The parent branch has no such command, so the diff-added work is discovery plus validation and the end state is the printed counts.
- [ ] Probe. Generate the fixture with a script in the PR. Run the command ten times on Node and ten times on Bun, alternating, and take each median.
- [ ] Baseline. Record that the parent branch produces no value, then record the first head medians.
- [ ] Rule. The PR fails when either median is above 2 seconds.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1, lane 2, and lane 10 transcripts into `docs/plans/media/m1-2-review-<slug>.txt`, and add one screenshot of the lane 2 terminal as `docs/plans/media/m1-2-review-errors.png`.
- [ ] Record a 30 to 60 second terminal video of `spindle validate` on a valid fixture and on an invalid fixture. Save it as `docs/plans/media/m1-2-review.mp4`.
- [ ] Post the screenshot and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends M1-2 to the stack above M1-1 and the operator lands the stack bottom-up.

## Persist threads in SQLite (M1-3)

The store holds four tables keyed by thread id. `threads` holds the agent name, the parent id, the arguments, the run state with its reason and its `since` time, and the terminated time. `messages` holds one row per message with a sequence number that only grows. `queue` holds pending messages and tool calls in arrival order. `kv` holds one JSON value per thread and key.

**Depends on.** M1-1.

**Files.**

- [x] Create `packages/runtime/src/store/ThreadStore.ts`, `schema.ts`, `migrations/0001_threads.ts`, and `sqlite.ts`.
- [x] Create `packages/runtime/scripts/store-probe.ts`.
- [x] Edit `packages/runtime/src/platform/node.ts` and `packages/runtime/src/platform/bun.ts` only if the store needs a `SqliteClient` option that M1-1 did not set.

**Build.**

- [x] Define `ThreadStore` as an Effect service whose methods return typed records and typed errors. The live layer needs `SqlClient` from `effect/sql/SqlClient` and names no SQLite package.
- [x] Write one implementation. Tests use the same implementation on an in-memory database. Do not add a second adapter.
- [ ] Run migrations with the `SqliteMigrator` module of the platform's SQLite package, reached through `#platform`.
- [x] Offer `ThreadStore.transaction`, which commits every store call inside it together or not at all. The caller picks the boundary. Runtime section 3 persists the assistant response before the tools run, so M1-4 decides which records share a transaction.
- [x] Implement the durable key-value rules from the second section 14 of the Runtime page. `setValue` with `null` or `undefined` deletes the key. `getValue` returns `null` for a key that was never set. A thread cannot read another thread's keys. A value that JSON cannot represent makes `setValue` fail with an error that names the key.
- [x] Implement message reads with `includeSilent`, a stable order by sequence number, and the paging options of `GetMessagesOptions`.
- [x] Change the `since` time of the run status only when the state or the reason changes.
- [x] Write `store-probe.ts` with one subcommand per live lane. Each subcommand prints what it wrote or read as JSON.

**You see.**

- [x] `node packages/runtime/scripts/store-probe.ts roundtrip --db /tmp/x.db` prints three message records in order, and a second process prints the same three.
- [x] `sqlite3 /tmp/x.db ".tables"` lists `threads`, `messages`, `queue`, and `kv`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `packages/runtime/test/store/contract.test.ts` gains one case per `ThreadStore` method and one case per key-value rule. Run `pnpm vitest run packages/runtime/test/store` on Node and on Bun.
- [ ] The ledger entries that `ledger.json` assigns to M1 in the second section 14 of `infrastructure:runtime`, and the entries for the persistence statements in `specification:threads/execution-state` section 4.3 change to `covered`. Run `pnpm check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. The parent branch has no store, so record that. At the head, run the `roundtrip` probe, then read the database from a new process. Save `roundtrip.txt`. Pass when both processes print the same three records in the same order.
- [ ] Lane 2. Append one message, send `SIGKILL` to the process after the append resolves, and read from a new process. Save `kill-after-append.txt`. Pass when the message is present.
- [ ] Lane 3. Send `SIGKILL` to the process inside one store transaction that writes a batch of three synthetic records. Save `kill-mid-transaction.txt`. Pass when the new process finds all three records or none of them.
- [ ] Lane 4. Set an object value, read it, set the key to `null`, and read it again. Save `kv-roundtrip.txt`. Pass when the first read equals the object and the second read is `null`.
- [ ] Lane 5. Write the same key on a parent thread, a child thread, and a sibling thread. Save `kv-isolation.txt`. Pass when each thread reads only its own value.
- [ ] Lane 6. Call `setValue` with a `BigInt`. Save `kv-non-json.txt`. Pass when the call fails with an error that names the key and the store holds no row for it.
- [ ] Lane 7. Enqueue 100 entries that mix messages and tool calls, restart the process, and dequeue them all. Save `queue-fifo.txt`. Pass when the dequeue order equals the enqueue order.
- [ ] Lane 8. Set the run status to the same state and reason twice, then to a new reason. Save `status-since.txt`. Pass when `since` is unchanged after the second write and changed after the third.
- [ ] Lane 9. Append one visible message and one silent message, then read with and without `includeSilent`. Save `silent-reads.txt`. Pass when the default read returns one record and the other read returns two.
- [ ] Lane 10. Write a database file with the probe on Node and read it with the probe on Bun, then the reverse. Save `cross-runtime-file.txt`. Pass when each runtime reads the records the other wrote.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Median time to append one message in its own transaction, and time to read 1,000 messages, on a file database. The parent branch has no store, so the diff-added work is the store call and the end state is a durable row.
- [ ] Probe. Run the `bench` subcommand of the probe for 2,000 appends and 50 reads, ten rounds on Node and ten rounds on Bun, alternating. Report both runtimes side by side with the SQLite version each one loads.
- [ ] Baseline. Record that the parent branch produces no value, then record the first head medians per runtime.
- [ ] Rule. The PR fails when the append median is above 2 milliseconds or the read of 1,000 messages is above 50 milliseconds on either runtime.

**Review gate.** None. M1-3 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends M1-3 to the stack above M1-2 and the operator lands the stack bottom-up.

## Run the step loop for a prompt side (M1-4)

Read `docs/plans/briefs/m1-4.md` before this section. A reviewer wrote it from the spec text before the build, and it corrects boxes and lanes below. Where the brief and this section differ, follow the brief. Where the brief and the spec differ, follow the spec and record the difference in Appendix A.

An execution moves through one ordered list of phases per step, which are drain, assemble, call, persist the response, run the tools, persist the results, and evaluate the stop rules. The loop records each phase in an `ExecutionTrace`. The stop rules are one ordered table that the loop reads top to bottom. User code is Promise-based and runs at the edge. The loop wraps each tool call in an Effect and builds the `ThreadState` object from the services the execution holds.

**Depends on.** M1-2 and M1-3.

**Files.**

- [x] Create `packages/runtime/src/execution/step.ts`, `assemble.ts`, `tools.ts`, `stop-rules.ts`, `trace.ts`, and `thread-state.ts`.
- [x] Create `packages/runtime/src/providers/openai-compatible.ts`.
- [x] Create `packages/runtime/src/cli/run.ts`.
- [x] Create `packages/conformance/src/ScriptedProvider.ts`, `packages/conformance/src/RuntimeDriver.ts`, and `packages/conformance/src/scenarios/step-loop.ts`.

**Build.**

- [x] Define `RuntimeDriver` in the conformance package. A driver creates a thread, sends a message, waits for the run to settle, reads messages, and returns the provider requests. Every scenario uses the driver and imports nothing from `packages/runtime`.
- [x] Write `ScriptedProvider` against `LLMProviderInterface` from `@standardagents/spec`. A script lists the responses in order, as text, tool calls, stream chunks, or errors. The provider records each request it receives.
- [x] Assemble the context. Interpolate the system prompt with its includes and variables, map the prompt side's own turns to `assistant` and the other side's turns to `user`, and convert the history to provider messages.
- [x] Call the model through the provider's stream, and persist the assistant message with its reasoning fields before any tool runs.
- [x] Generate each tool's JSON Schema from its Zod arguments, validate the model's arguments against the schema, and run the tool calls one at a time in the order the model returned them.
- [x] Persist a tool error as a tool result and continue the loop.
- [x] Evaluate `stopTool`, then `stopOnResponse`, then `maxSteps`, from the one stop-rule table. Pass `toolChoice` through, including `none` with the tool definitions.
- [x] Write `openai-compatible.ts` against `LLMProviderInterface` for the chat completions wire format. It reads the base URL and the key from provider config slots. The real-model lanes set those slots from `SPINDLE_TEST_BASE_URL`, `SPINDLE_TEST_API_KEY`, and `SPINDLE_TEST_MODEL`. The key is optional, because a local server needs none. The model must support tool calls and streaming.
- [x] Export the provider from `packages/runtime` as a factory named `openaiCompatible`, so that a file under `agents/models/` can import it and pass it as `provider`.
- [x] Copy the Hello, World example from the spec's Examples page into `packages/conformance/fixtures/hello-world/`. Change only the provider import in `agents/models/conversational.ts`.
- [x] Add `spindle run <agent> -m <text>`. It loads the `agents/` folder of the current directory, and `--dir <path>` names a different project directory. `--script <file>` selects the scripted provider. `--trace` prints the phase trace. `--dump-requests` prints each provider request as JSON. `--db <file>` selects the database.

**You see.**

- [x] `spindle run assistant -m "hello" --script text-reply.json --db /tmp/x.db` prints the assistant text and exits 0.
- [x] `spindle run assistant -m "hello" --script text-reply.json --trace` prints the phases in the order drain, assemble, call, persist-response, tools, persist-results, stop.
- [x] `spindle run assistant --dir packages/conformance/fixtures/hello-world -m "What does idempotent mean?"` prints a reply from the model at `SPINDLE_TEST_BASE_URL`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `packages/conformance/src/scenarios/step-loop.ts` gains one scenario per statement in sections 3, 4, 5, and 6 of the Runtime page that this PR covers. `packages/runtime/test/conformance.test.ts` runs every scenario through the Spindle driver. Run `pnpm vitest run packages/runtime/test/conformance.test.ts` on Node and on Bun.
- [x] `packages/runtime/test/execution/stop-rules.test.ts` gains one case per row of the stop-rule table and one case per pair of rows that can both match.
- [x] The ledger entries for those statements, and for the statements in `specification:tools` section 9 and `specification:prompts` sections 4.2 and 5.2, change to `covered`. Run `pnpm check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. The parent branch has no `spindle run`, so record that. At the head, run the text-reply script. Save `text-reply.txt`. Pass when the exit code is 0 and the database holds one user message and one assistant message.
- [ ] Lane 2. Script one response with two tool calls, where the second tool reads a value the first tool writes. Save `sequential-tools.txt`. Pass when the trace shows the first result persisted before the second tool starts and the second tool read the value.
- [ ] Lane 3. Script a call to a tool that throws. Save `tool-error.txt`. Pass when the error is a persisted tool result, the next model call happens, and the exit code is 0.
- [ ] Lane 4. Run an agent with `stopTool` set, and script a call to that tool followed by more responses. Save `stop-tool.txt`. Pass when the provider received exactly one request.
- [ ] Lane 5. Run an agent with `stopOnResponse` set to `false` and `maxSteps` set to 3, with a script that never stops. Save `max-steps.txt`. Pass when the provider received exactly three requests and the run settles with a step-limit reason.
- [ ] Lane 6. Script a tool call to a tool that sleeps, and send `SIGKILL` to the process during the sleep. Save `persist-before-advance.txt`. Pass when the database already holds the assistant message with its tool call.
- [ ] Lane 7. Run a prompt with `toolChoice` set to `none` and with `--dump-requests`. Save `tool-choice-none.txt`. Pass when the request carries `toolChoice` as `none` and still carries the tool definitions.
- [ ] Lane 8. Run a prompt that includes a second prompt and interpolates one variable, with `--dump-requests`. Save `system-prompt.txt`. Pass when the system message holds the included text and the variable's value.
- [ ] Lane 9. Script a tool call whose arguments violate the tool's schema. Save `invalid-args.txt`. Pass when the tool did not run, a tool error result is persisted, and the exit code is 0.
- [ ] Lane 10. Run an agent with one function tool against a real model through `openai-compatible.ts`, with the endpoint from `SPINDLE_TEST_BASE_URL`. Save `real-model.txt`. Pass when the database holds a tool result and a final assistant message. If no endpoint is set, report `BLOCKED`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Median wall time that Spindle adds per step, measured with a scripted provider that answers at once and one tool that returns at once. The parent branch has no loop, so the diff-added work is one full step and the end state is a settled run.
- [ ] Probe. Run a 200-step scripted run on a file database, ten rounds on Node and ten rounds on Bun, alternating. Divide the run time by the step count.
- [ ] Baseline. Record that the parent branch produces no value, then record the first head medians per runtime.
- [ ] Rule. The PR fails when the per-step median is above 10 milliseconds on either runtime.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 1, lane 2, and lane 10 transcripts into `docs/plans/media/m1-4-review-<slug>.txt`, and add one screenshot of the lane 2 terminal as `docs/plans/media/m1-4-review-trace.png`.
- [ ] Record a 30 to 60 second terminal video of `spindle run` with `--trace` on the two-tool script. Save it as `docs/plans/media/m1-4-review.mp4`.
- [ ] Post the screenshot and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends M1-4 to the stack above M1-3 and the operator lands the stack bottom-up.

## Run hooks at every specified position (M1-5)

Read `docs/plans/briefs/m1-5.md` before this section. A reviewer wrote it from the spec text before the build, and it corrects boxes and lanes below. Where the brief and this section differ, follow the brief. Where the brief and the spec differ, follow the spec and record the difference in Appendix A.

The spec defines fourteen hooks, and this PR implements thirteen of them. The hook positions are one table from `HookName` to where the loop calls it, what the return value replaces, and what a failure does. The loop reads the table. No phase has its own hook code. A context assembly owns one history snapshot, and a message that arrives after the snapshot starts belongs to the next assembly.

**Depends on.** M1-4.

**Files.**

- [ ] Create `packages/runtime/src/execution/hooks.ts` and `packages/runtime/src/execution/snapshot.ts`.
- [x] Edit `packages/runtime/src/execution/assemble.ts`, `tools.ts`, and `thread-state.ts`.
- [x] Create `packages/conformance/src/scenarios/hooks.ts` and `packages/conformance/src/scenarios/messages.ts`.

**Build.**

- [x] Resolve the hook set of the active prompt and agent, with unique ids, in declaration order.
- [x] Run the seven assembly steps in the order that section 4 of the Runtime page gives. Call `filter_messages` exactly once per assembly, on a stable snapshot that includes silent messages.
- [x] Keep the output of `filter_messages` and of `prefilter_llm_history` inside the request. `execution.messageHistory` lists the persisted records only.
- [x] Implement `injectMessage` on `ThreadState`. It runs `before_create_message` and `after_create_message`, resolves after the record is readable through `getMessage`, and never restarts an assembly.
- [x] Call `before_update_message` and `after_update_message` around every update.
- [x] Call the five tool hooks at the positions that section 5 of the Hooks page gives. `tool_call_started` and `tool_call_done` each run exactly once per tool call.
- [x] Call `after_thread_created` when a thread is created. `after_subagent_created` waits for M3.
- [x] Give each hook call a timeout from one config value, and log a hook failure without the hook's arguments.

**You see.**

- [x] `spindle run assistant -m "hello" --script text-reply.json --trace` on the hooks fixture prints `after_system_message`, `snapshot`, `filter_messages`, `transform`, `prefilter_llm_history`, and `dispatch` in that order.
- [x] The same run prints `filter_messages` once per model call.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `packages/conformance/src/scenarios/messages.ts` gains the seven scenarios from section 7 of the Messages page, one scenario per table row. Run `pnpm vitest run packages/runtime/test/conformance.test.ts` on Node and on Bun.
- [x] `packages/conformance/src/scenarios/hooks.ts` gains one scenario per statement in sections 3, 4, and 5 of the Hooks page.
- [ ] The ledger entries for `specification:hooks` sections 3 to 5, `specification:threads/messages`, and `specification:threads/execution-state` section 2.2 change to `covered`. Run `pnpm check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the text-reply script on a fixture with no hooks at the parent branch and at the head, with `--dump-requests`. Save `no-hooks-regression.txt`. Pass when the provider requests and the persisted messages are identical on both.
- [ ] Lane 2. Run a tool that injects a message during an execution, followed by a second tool. Save `inject-active.txt`. Pass when each create hook ran once, `getMessage` returns the record, and the second tool saw it on `execution.messageHistory`.
- [ ] Lane 3. Inject a message into an idle thread with the probe, then read messages before any run. Save `inject-at-rest.txt`. Pass when both create hooks ran and the message is readable.
- [ ] Lane 4. Inject one silent message and one visible message, then run one step with `--dump-requests`. Save `silent-visible.txt`. Pass when both are in the request, both are on `execution.messageHistory`, and a default message read omits the silent one.
- [ ] Lane 5. Run a `filter_messages` hook that drops all but the last two messages and adds one synthetic message. Save `filter-request-only.txt`. Pass when the request holds three messages and `execution.messageHistory` still holds every persisted record and no synthetic record.
- [ ] Lane 6. Inject a message from `filter_messages`, and in a second run from `prefilter_llm_history`. Save `inject-from-filters.txt`. Pass when the message is absent from the current request, present in the next request, and `filter_messages` ran once per assembly.
- [ ] Lane 7. Inject a message from `after_system_message`. Save `inject-after-system.txt`. Pass when the message is in the current request and the `filter_messages` hook received it.
- [ ] Lane 8. Run one tool that succeeds and one tool that throws, with a logging hook at every tool position. Save `tool-hook-order.txt`. Pass when each call logs started once and done once, and the success and failure hooks each ran for the matching call only.
- [ ] Lane 9. Run a `before_create_message` hook that throws, then an `after_create_message` hook that throws. Save `create-hook-failures.txt`. Pass when the first message was not created and the second message exists.
- [ ] Lane 10. Run a hook that never resolves. Save `hook-timeout.txt`. Pass when the run settles after the configured timeout and the log line names the hook id and holds no message content.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The per-step median from M1-4, on a fixture with no hooks and on a fixture with one no-op hook at each of the thirteen positions this PR implements.
- [ ] Probe. Run the M1-4 probe at the parent branch and at the head, interleaved, ten rounds each, on Node and on Bun.
- [ ] Baseline. Record the parent branch's per-step median on the no-hooks fixture first.
- [ ] Rule. The PR fails when the head's no-hooks median is more than 20 percent above the parent's, or when the thirteen no-op hooks add more than 2 milliseconds per step.

**Review gate.** None. M1-5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends M1-5 to the stack above M1-4 and the operator lands the stack bottom-up.

## Queue work and keep one execution per thread (M1-6)

Read `docs/plans/briefs/m1-6.md` before this section. A reviewer wrote it from the spec text before the build, and it corrects boxes and lanes below. Where the brief and this section differ, follow the brief. Where the brief and the spec differ, follow the spec and record the difference in Appendix A.

A thread's run status is one state machine with the states `idle`, `running`, and `failed`, plus a reason. Each thread has one durable inbox, the `queue` table, and at most one fiber that drains it. A lease row in the store names the process that holds a thread, so a second process cannot start a second execution and a restart can find the executions that died.

**Depends on.** M1-5.

**Files.**

- [ ] Create `packages/runtime/src/execution/ThreadSupervisor.ts`, `run-status.ts`, and `lease.ts`.
- [ ] Create `packages/runtime/src/store/migrations/0002_leases.ts`.
- [ ] Edit `packages/runtime/src/execution/step.ts`, `thread-state.ts`, and `packages/runtime/src/cli/run.ts`.
- [ ] Create `packages/conformance/src/scenarios/queue.ts` and `packages/conformance/src/scenarios/run-status.ts`.

**Build.**

- [ ] Define `ThreadSupervisor` as an Effect service that owns one fiber per active thread. A new trigger for an idle thread starts an execution. A new trigger for an active thread goes to the queue.
- [ ] Implement `queueMessage` and `queueTool` on `ThreadState`. The drain phase takes queued entries in arrival order before the next model call.
- [ ] Take the lease in the same transaction that sets `running`. Release it in the same transaction that settles the run.
- [ ] Settle every execution to `idle` or `failed`, including an execution that throws. At process start, settle each thread whose lease holder is gone to `failed` with reason `execution_lost`.
- [ ] Make `execution.stop()` cooperative. It sets a flag that the loop reads at each boundary. The operation in flight finishes, its result is stored, and no abort signal fires. A stopped run settles to `idle` with a stop reason. Fire `execution.abortSignal` and interrupt the fiber only for terminate and for an explicit abort.
- [ ] Implement `terminate()`. It sets the terminated time, interrupts the fiber, and makes later send, queue, and execute calls fail with a typed error.
- [ ] Add `spindle send <thread> -m <text>` and `spindle status <thread>` so that two processes can address one thread.

**You see.**

- [ ] `spindle status <thread>` prints `idle`, `running`, or `failed` with the reason and the `since` time.
- [ ] After a `SIGKILL` during a run and a restart, `spindle status <thread>` prints `failed execution_lost`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/conformance/src/scenarios/queue.ts` gains one scenario per statement in sections 2, 9, 10, and 11 of the Runtime page. Run `pnpm vitest run packages/runtime/test/conformance.test.ts` on Node and on Bun.
- [ ] `packages/conformance/src/scenarios/run-status.ts` gains one scenario per statement in section 4.3 of the Execution State page.
- [ ] `packages/runtime/test/execution/run-status.test.ts` gains one case per legal transition and one case per illegal transition of the run-status state machine.
- [ ] The ledger entries for those statements change to `covered`. Run `pnpm check`. The last line reports the covered count for milestone 1.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the text-reply script with `--trace` at the parent branch and at the head. Save `single-run-regression.txt`. Pass when the phase traces and the persisted messages are identical.
- [ ] Lane 2. Call `queueMessage` on an idle thread through the probe. Save `queue-idle.txt`. Pass when an execution starts without a send and the status goes `running` then `idle`.
- [ ] Lane 3. Queue a message while a slow tool runs. Save `queue-active.txt`. Pass when the second provider request holds the queued message.
- [ ] Lane 4. Queue two messages and one tool call during a slow tool. Save `queue-fifo-live.txt`. Pass when the trace shows the three entries drained in arrival order.
- [ ] Lane 5. Start `spindle send` to one thread from two processes at the same moment. Save `two-processes.txt`. Pass when the trace shows the first execution settled before the second one started.
- [ ] Lane 6. Send to two different threads at the same moment, each with a slow tool. Save `two-threads.txt`. Pass when the two executions' time ranges overlap.
- [ ] Lane 7. Send `SIGKILL` to the process during a run, then start a new process. Save `execution-lost.txt`. Pass when the status is `failed` with reason `execution_lost` and no thread is `running`.
- [ ] Lane 8. Send a new message to the thread from lane 7. Save `recover-after-loss.txt`. Pass when the status goes `running` then `idle` and the earlier messages are still present.
- [ ] Lane 9. Stop an execution during a slow tool that watches `abortSignal`. Save `stop-during-tool.txt`. Pass when the tool finished without seeing an abort, its result is stored, no further model call or tool call starts, and the status settles to `idle` with a stop reason.
- [ ] Lane 10. Terminate a thread during a run, then send to it. Save `terminate.txt`. Pass when the run is interrupted, the terminated time is set, and the send fails with an error that says the thread is terminated.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The per-step median from M1-4 at the parent branch and at the head, and the wall time for 100 threads to each process 10 queued messages with a scripted provider.
- [ ] Probe. Run the M1-4 probe at the parent branch and at the head, interleaved, ten rounds each. Run the 100-thread probe at the head ten times. Do both on Node and on Bun.
- [ ] Baseline. Record the parent branch's per-step median first. The parent branch has no queue, so record that the 100-thread probe has no parent value.
- [ ] Rule. The PR fails when the head's per-step median is more than 20 percent above the parent's, or when the 100-thread probe takes more than 10 seconds on either runtime.

**Review gate.** None. M1-6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends M1-6 to the stack above M1-5 and the operator lands the stack bottom-up.

## Chat with an agent from the terminal (M1-7)

`spindle chat` is a loop over one thread. It reads a line, sends the line as a message, prints each record the run persists, and waits for the run to settle. The command holds no state of its own. The thread id is the only thing a later session needs.

**Depends on.** M1-6.

**Files.**

- [ ] Create `packages/runtime/src/cli/chat.ts`.
- [ ] Edit `packages/runtime/src/execution/ThreadSupervisor.ts` to expose a stream of the records a thread persists.
- [ ] Create `packages/runtime/test/cli/chat.test.ts`.

**Build.**

- [ ] Add `spindle chat <agent>`. It takes `--dir`, `--db`, and `--script` with the same meaning as in `spindle run`, and `--thread <id>` to continue an existing thread.
- [ ] Validate the project directory before the first prompt. Print the issues that `spindle validate` prints and exit 1 when any issue is an error.
- [ ] Print the thread id at the start. Print the command that resumes the thread at exit.
- [ ] Read lines through the Effect `Terminal` service, so the command imports no platform module.
- [ ] Print each persisted record as the run produces it. An assistant message prints its text. A tool call prints one line with the tool name and its arguments. A tool result prints one line with the tool name and `ok` or the error message.
- [ ] Make Ctrl-C during a run call `execution.stop()` and return to the prompt. Make Ctrl-C or end of input at the prompt exit with code 0.
- [ ] Load definitions once per process. To pick up an edited definition, exit and run the resume command.

**You see.**

- [ ] `spindle chat assistant --dir packages/conformance/fixtures/hello-world` prints `thread <id>` and a prompt, and each line you type prints a reply.
- [ ] At exit the command prints `resume with spindle chat assistant --thread <id>`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/runtime/test/cli/chat.test.ts` gains one case per build box above, each driven by a test `Terminal` layer with scripted input lines. Run `pnpm vitest run packages/runtime/test/cli/chat.test.ts` on Node and on Bun.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `claude-sonnet-5-5` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. The parent branch has no `spindle chat`, so record that. At the head, pipe three lines into `spindle chat` with a scripted provider. Save `three-turns.txt`. Pass when three replies print in order and the thread holds six messages.
- [ ] Lane 2. Exit a chat after one turn, then run the printed resume command and send one more line with `--dump-requests`. Save `resume.txt`. Pass when the second session's provider request holds the first session's messages.
- [ ] Lane 3. Chat with an agent whose script calls one tool that succeeds and one tool that throws. Save `tool-lines.txt`. Pass when the output shows one call line and one result line per tool, with `ok` for the first and the error message for the second.
- [ ] Lane 4. Send Ctrl-C during a slow tool. Save `interrupt-run.txt`. Pass when the prompt returns, `spindle status` prints `idle` with a stop reason, and the next line gets a reply.
- [ ] Lane 5. Send Ctrl-C at the prompt, and in a second run close the input. Save `exit-at-prompt.txt`. Pass when both runs exit with code 0 and both print the resume command.
- [ ] Lane 6. Run `spindle chat` on the both-sides-human fixture. Save `invalid-directory.txt`. Pass when the issue line prints, the exit code is 1, and no prompt appears.
- [ ] Lane 7. Chat one turn, exit, edit the text of the prompt file, and resume with `--dump-requests`. Save `edit-and-resume.txt`. Pass when the next request's system message holds the edited text.
- [ ] Lane 8. Chat against a base URL that refuses connections, then fix the URL and resume. Save `provider-down.txt`. Pass when the first session prints the provider error and stays at the prompt, and the resumed session gets a reply.
- [ ] Lane 9. Run lane 1 and lane 4 under Bun. Save `chat-bun.txt`. Pass when both meet the same predicates.
- [ ] Lane 10. Chat three turns with the hello-world fixture against the real model at `SPINDLE_TEST_BASE_URL`, where the third line refers to the first. Save `real-model-chat.txt`. Pass when the third reply uses a fact from the first turn. If no endpoint is set, report `BLOCKED`.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from process start to the first prompt, and time from a submitted line to the first printed record with a scripted provider. The parent branch has no chat, so the diff-added work is the read loop and the record stream, and the end state is a printed reply.
- [ ] Probe. Drive `spindle chat` through a pseudo-terminal script in the PR, twenty turns per round, ten rounds on Node and ten rounds on Bun, alternating. Run the M1-4 per-step probe at the parent branch and at the head, interleaved.
- [ ] Baseline. Record the parent branch's per-step median first, and record that the parent branch has no chat value.
- [ ] Rule. The PR fails when the first prompt takes more than 1 second, when the first record takes more than 50 milliseconds beyond the per-step median, or when the head's per-step median is more than 20 percent above the parent's.

**Review gate.** The operator reviews before merge.

- [ ] Copy the lane 3 and lane 10 transcripts into `docs/plans/media/m1-7-review-<slug>.txt`, and add one screenshot of the lane 3 terminal as `docs/plans/media/m1-7-review-tools.png`.
- [ ] Record a 30 to 60 second terminal video of a chat with a tool call, an interrupted run, and a resume. Save it as `docs/plans/media/m1-7-review.mp4`.
- [ ] Post the screenshot and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Automated review comments triaged.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The root appends M1-7 to the stack above M1-6 and the operator lands the stack bottom-up.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] `pnpm check` on `main` prints the covered count for milestone 1, and no milestone 1 entry in `ledger.json` is still `planned`.
- [ ] Reply to the operator with the report that `autopilot-stack.md` names, and with the list in `packages/conformance/DIVERGENCES.md`.

## Appendix A. Prototype evidence

Each row was run in this planning session on macOS with Node 22.22.3 and Bun 1.4.5. The probes were one-line scripts with no dependencies, so no branch holds them. The requirement script is the exception and is committed.

| Question | Result | How it was checked |
|---|---|---|
| How many normative statements does spec 0.2.0 hold? | 606 statements with an RFC 2119 keyword, 61 with a lowercase "must" or "should", and 110 curated statements with no keyword, on 24 pages, with 777 unique ids. The first count was 458 and 54, because the script dropped each list item and table row under a line such as "The runtime MUST" that ends in a colon. The second count was 580 and 61, because the script read only the last sentence of a lead-in and skipped a table under a lead-in that ends in a period. | `node scripts/spec-requirements.mjs --refresh --check` at spec commit `f462a67`. |
| Is Effect v4 stable? | `effect@4.1.5` is the `latest` tag. Version 4.0.0 was published on 2026-10-01. | `npm view effect dist-tags time`. |
| Do the Effect platform modules this plan names exist? | `@effect/platform-node@4.1.5` ships `NodeRuntime`, `NodeServices`, and `NodeHttpServer`. `@effect/platform-bun@4.1.5` ships `BunRuntime`, `BunServices`, and `BunHttpServer`. Both SQLite packages ship `SqliteClient` and `SqliteMigrator`. | The file index of each package on unpkg. |
| Does the Node SQLite package need a native addon? | No. `@effect/sql-sqlite-node@4.1.5` imports `node:sqlite` and has `effect` as its only dependency. | The import list of its `dist/SqliteClient.js`. |
| Does `node:sqlite` work on the installed runtimes? | Yes on both. Node prints an `ExperimentalWarning`. | A one-line script that opens an in-memory database. |
| Can one package pick the Node module or the Bun module without a runtime check? | Yes. An `imports` entry with a `bun` condition and a `default` condition resolved to the Bun file under Bun and to the Node file under Node. | A three-file probe in `/tmp/spindle-cond-probe`. |
| Does Node import `.ts` files directly? | Node 22.22.3 reports `process.features.typescript` as `strip`. | `node -e`. |
| Is there a model endpoint for the real-model lanes? | Yes. The operator runs a local server at `http://localhost:8317/v1`. It answered one streaming chat completions request for `claude-haiku-5-5` with a `get_weather` tool call and the finish reason `tool_calls`. It needs a key, and the key is already in the environment as `ANTHROPIC_API_KEY`. | One `curl` request with a tool definition. |

These questions stay unproven.

- Whether the Bun store is faster than the Node store. M1-3 measures both. Until then "faster" is a guess.
- Whether `@standardagents/openai` loads under plain Node. The permission classifier blocked the probe that installs and imports it.
- Whether the official `@standardagents/client` works against Spindle. A later milestone builds the Thread Client API.

### Settled in M1-1

The M1-1 owner ran each command below on 2026-11-25 on macOS, from the repository root, with Bun 1.4.5.

**Vitest under Bun.** Vitest 5.1.2, which `@effect/vitest@4.1.5` requires, runs under Bun with `bun --bun vitest run`. Vite resolves imports with its own condition list, which lacks `bun`, so `#platform` first resolved to `node.ts` and the SQLite case failed inside Bun's `node:sqlite` shim. `vitest.config.ts` now adds the `bun` condition when Vitest runs on Bun, and it names the Vitest project after the runtime, so each result line shows which runtime ran it.

```text
$ bun --bun vitest run          # before the bun condition
Caused by: Error: the loaded SQLite library was built with SQLITE_OMIT_LOAD_EXTENSION.
 Test Files  1 failed (1)
      Tests  2 failed (2)

$ bun --bun run test            # after
 ✓ |bun| packages/runtime/test/platform.test.ts > platform > resolves #platform to the module for the running runtime 1ms
 ✓ |bun| packages/runtime/test/platform.test.ts > platform > loads the SQLite package only when SqliteLive builds 7ms
 ✓ |bun| packages/runtime/test/platform.test.ts > platform > reads back a row from an in-memory SQLite database 2ms
      Tests  18 passed (18)
```

`bun --bun run check` runs every `pnpm check` step under Bun, including the nested `pnpm` calls. Its output held 18 `|bun|` result lines and no `|node|` line. The first platform case asserts that `#platform` resolved to `bun.ts` exactly when `process.versions.bun` is set.

**The `engines` floor.** `engines.node` is `>=22.19.0`. `npm view @effect/platform-node@4.1.5 engines` prints `{ node: '>=22.19.0' }`, so no lower claim is honest. Node 22.19.0 was already installed through mise and Node 24.10.0 through nvm. `pnpm test`, `pnpm check`, and `spindle --version` pass on Node 22.19.0, 22.22.3, and 24.10.0. On 22.19.0, `pnpm test` printed 18 `|node|` result lines and `Tests  18 passed (18)`. `import.meta.main` and `import.meta.dirname` also work on 22.19.0.

**Effect v4 names.** These come from the `.d.ts` files under `node_modules/@effect` and `node_modules/effect/dist`.

- `NodeServices.layer` and `BunServices.layer` provide `ChildProcessSpawner`, `FileSystem`, `Path`, `Stdio`, and `Terminal`. That set is the `Environment` that `Command.run` in `effect/cli` requires.
- `NodeRuntime.runMain` and `BunRuntime.runMain` take an `Effect` with no requirements.
- `SqliteClient.layer({ filename })` in both SQLite packages provides the package's own `SqliteClient` and the shared `SqlClient` from `effect/sql/SqlClient`. Both default to a 5 second busy timeout and WAL mode.
- `effect/cli` replaces `@effect/cli`. Its built-in `--version` flag prints `<name> v<version>`.

**Where M1-1 differs from this plan.**

- The platform modules export `PlatformLive` without a database, and `SqliteLive({ filename })` for the database. Importing `@effect/sql-sqlite-node` loads `node:sqlite`, which prints an `ExperimentalWarning` on Node 22, and `spindle --version` and `spindle validate` need no database. `node.ts` loads the SQLite package only when `SqliteLive` builds. The platform test opens its in-memory database through `SqliteLive`. The two boxes that say "through `PlatformLive`" stay unchecked until the root accepts or rejects the split.
- The `#platform` entry has a third condition, `spindle-source`, that points at the `.ts` files. `tsc` and Vitest set it. Node and Bun do not, so the built CLI resolves to `dist`.
- The Biome import rule covers `packages/runtime` only. `scripts/` and `packages/conformance` are tooling and import `node:` modules.
- The 8 statements on `getting-started:examples` are `not-testable`, because they come from example prompts for coding agents. The box that asks for `planned` on every other entry stays unchecked for that reason.
- Appendix E names pages for M2 through M7 only, so `scripts/seed-ledger.mjs` assigns milestones from a rule table. Its M1 rules follow the M1-2 through M1-7 sections. Its rules for the providers pages, most of the tools page, and a few sections of threads, hooks, and messages are judgment calls.
- A ledger entry names a test the way Vitest prints it, `<file> > <describe> > <title>`. The ledger step reads the Vitest JSON report that `pnpm test` writes, so it also fails when a named test did not pass.
- `pnpm check` runs the requirement check before the ledger check, so its last line is the ledger line.

### Settled in M1-2

The M1-2 owner ran each command below on 2026-11-25 on macOS, from the repository root, with Node 22.22.3, Node 22.19.0, and Bun 1.4.5. Transcripts are in `/tmp/spindle-m1-2/evidence/` on that machine.

**The project directory.** `spindle validate [dir]` takes the project directory, which holds `agents/` and may hold `node_modules/`. The default is the current directory. A directory without `agents/` gets the issue `agents_directory_missing`, and its message names the directory.

**Loading `.ts` files.** Node 22.19.0 and 22.22.3 import a definition file with a dynamic `import()` and print no warning. An `enum` fails with the code `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, and `spindle validate` turns that code into a sentence that names the cause and the fix. Bun transpiles the `enum` and loads the file. Node also refuses to strip types under `node_modules` and reports `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, so a packed package must ship JavaScript. Vitest transforms TypeScript itself, so the enum case has a unit test of the message only. The fixture `packages/conformance/fixtures/typescript-enum` sits outside `invalid/` because it is valid on Bun.

**Files without import or export syntax.** Node runs such a `.ts` file as CommonJS when no `package.json` above it sets `"type": "module"`, and gives it an empty object as its default export. Bun gives it no default export. No kind accepts an empty object, so the loader treats one as no export, and both runtimes report `definition_export_missing` for an empty file, a comment-only file, and a file that defines a value without exporting it. A file that writes `export default {}` gets the same issue. Vitest transforms imports itself, so `packages/runtime/test/cli/validate.test.ts` runs `main.ts` under the current runtime on a copy of `invalid/empty-files` in a temporary directory.

```text
$ node packages/runtime/dist/cli/main.js validate packages/conformance/fixtures/typescript-enum
definition_load_failed error agents/tools/lookup.ts The file uses TypeScript syntax that Node cannot strip, such as an enum, a namespace, or a constructor parameter property. ...
exit 1
$ bun packages/runtime/dist/cli/main.js validate packages/conformance/fixtures/typescript-enum
0 errors, 0 warnings
exit 0
```

**Identifiers.** The registry finds an agent, a prompt, or a model by its `name` and a hook by its `id`, because Prompts section 8 and Models section 3.2 say that references use those fields. It finds a tool, a handler, or an effect by its file name, or by its export key in a package. An identifier that differs from the file name or export key gets the warning `definition_name_mismatch`. Two definitions of one kind that declare one identifier in a namespace get `definition_name_duplicate`. `packages/conformance/DIVERGENCES.md` records this rule and five other choices. The first round used the file name for every kind, and the spec audit showed that it rejected a legal hook.

**One pass.** Every failure to read, parse, or import a file becomes one issue that names the file, and validation goes on. That covers a `package.json` that is not JSON, a kind directory that is a file, a definition that throws inside a check, and each line of the error that `defineAgent` throws. The `Registry` layer's error type is `never`.

**Output.** Each issue line is `<code> <severity> <file>[:<field path>] <message>`. The issues are sorted by file, field path, and code. Two summary lines follow, the count of each kind and the count of errors and warnings. `--json` prints a list of objects with `code`, `severity`, `message`, `file`, and `path`. `--list` prints a table with the columns `KIND`, `QUALIFIED NAME`, `PACKAGE`, `NAME`, and `VISIBILITY`. The command exits 1 when any issue is an error, and 0 when every issue is a warning.

**Effect v4 names.** These come from the `.d.ts` files under `node_modules/effect/dist`.

- `Command.make("spindle").pipe(Command.withSubcommands([validateCommand]))` adds the subcommand. `Command.runWith(command, { version })(args)` runs it in a test.
- `Flag.Boolean("json")` fails when the flag is absent, so each flag adds `Flag.withDefault(false)`. `Argument.String("dir").pipe(Argument.withDefault("."))` makes the directory optional.
- `runMain` exits 1 on a failure and logs it unless the error sets `[Runtime.errorReported]` to `false`. `IssuesFound` sets it, so a failed validation prints no stack trace.
- `Context.Service<Self, Shape>()("key")` declares the `Registry` service. `Effect.cached` makes each lazy loader run once.
- `Console.Console` is a `Context.Reference`, so a test replaces it with `Effect.provideService` and reads the printed lines.

**Package fixtures.** Git ignores every `node_modules/` directory, so no committed fixture can hold one. The fixtures that use a package link it from `agents/packed/` with a relative symlink, and lane 7 "installs" `packed-a` and `packed-b` that way. The unit test for `node_modules` discovery copies `packed-a` into a temporary directory. A package's `__meta.packageId` must equal its `package.json` name. A package's entry must resolve, after `realPath`, inside the resolved package directory, or Spindle reports `package_invalid` and imports nothing. A package must export every registry except `effects` and `threadEndpoints`, and every loader must return a Promise. Biome cannot lint a `package.json` that is not JSON, so the tests write that file into a temporary copy of `invalid/broken-manifest`.

**The ledger.** 71 entries are `covered` and 13 are `partial`. The partial entries are Agents section 6 (two entries, M3 composes), Handlers section 2 (two entries, M4 owns effect schedules), Tools section 2.1 (M1-6 and M2 own invocations outside `uses`), Packaging parent hooks (M3 activates them on composition), Prompts section 2.4 recursive expansion (M1-4 renders), the handler `execute` contract and the `defineHandler` brand (M1-6), typed hook `execute` (M1-5), and the provider factory and `defineModel` contracts (M1-4). The first round marked 81 entries `covered`, and the spec audit showed that the named tests did not prove nine of them. Five Packaging entries are `not-testable`, because they constrain package authors. The M1 entries on these pages that describe runtime behavior, such as tool choice, input schemas, hook timing, and tool annotations, stay `planned` for M1-4 and M1-5. 25 curated statements were added, which brings the count line to `606 RFC 2119 statements, 61 lowercase must or should statements, 135 curated statements with no keyword, 24 pages`. The first round added 26, and one repeated the last sentence of `specification:tools:dc9a10a7`.

**Where M1-2 differs from this plan.**

- The Build box names Node 22.22. Node 22.19.0, the `engines` floor, also strips types.
- The visibility table has one empty cell, Global to Same Package, so `resolve.test.ts` has seven cell cases, not eight.
- Subagents section 2.4 was assigned to M3. M1-2 checks it at load time, so the entry moved to M1.
- The plan does not list the Effects page for M1-2. Its definition rules, `defineEffect` default exports and unique file-based names, are load-time checks, so three Effects entries moved from M4 to M1.
- The file boundary names `src/registry`, `src/cli`, and `fixtures`. M1-2 also adds `test/registry`, `test/cli`, and edits `requirements.extra.json`, `requirements.json`, `ledger.json`, and `DIVERGENCES.md`, as the owner brief allows.
- `packages/conformance/fixtures/generate-large.mjs <dir>` writes the 200-definition fixture for the perf lane. One unmeasured run took 0.37 seconds on Node and 0.13 seconds on Bun. The perf lane owns the real medians.
- The plan describes the registry as a map to lazy loaders. A name in a `name` or `id` field is known only after the file loads, so the `Registry` layer loads every definition once when it builds and keeps the values. Each `Definition` still has its cached `load` effect.

### Settled in M1-3

The M1-3 owner ran each command below on 2026-11-25 on macOS, from the repository root, with Node 22.22.3 and Bun 1.4.5. Transcripts are in `/tmp/spindle-m1-3/evidence/` on that machine.

**Columns.** The plan names the four tables. These columns are the owner's choice, and each names the need that drove it.

- `threads` adds `created_at` for `ThreadState.createdAt`. The run status is three columns, `run_state`, `run_reason`, and `run_since`. A never-run thread reads `idle`, since `0`, reason `null`, which Execution State 4.1 requires. A `CHECK` keeps `run_reason` null while the state is `running`. `user_id` is absent because the Users page is a Draft.
- `messages` has one column per field of the spec's `Message` record, except the nine `subagent_*` fields. The spec calls those projections of the child registry, so M3 computes them at read time. `seq` is an `AUTOINCREMENT` key, so it only grows, even after a delete. `reasoning_content`, `reasoning_details`, and `prompt` serve M1-4, which persists reasoning with the assistant message. `silent`, `metadata`, `parent_id`, and `depth` serve the M1-5 lanes and the `maxDepth` read option. `status` serves M1-6, which marks queued messages `pending`.
- `queue` holds `kind` (`message` or `tool`), a JSON `payload`, and `queued_at`. The payload of a message is the package's `QueueMessageInput`, and the payload of a tool call is the tool name and its arguments. M1-6 lanes 2 to 4 drain it.
- `kv` holds the value as JSON text, keyed by thread id and key.
- Every time column holds microseconds since the epoch, like `created_at` in the package and `since` in Execution State 4.

**Durability.** The store sets `synchronous = FULL` on top of the WAL mode that both SQLite clients set. WAL with `NORMAL` already survives `SIGKILL`, because a commit reaches the operating system before `COMMIT` returns. `FULL` also calls `fsync` on each commit, which on Linux makes a commit survive an operating system crash. On macOS `fsync` does not flush the drive cache, so `FULL` does not survive power loss there. In 4 interleaved rounds of 2,000 appends each, the median append took 0.062 ms with `NORMAL` and 0.093 ms with `FULL` on Node, and 0.058 ms and 0.146 ms on Bun. Why Bun pays more for `fsync` is a guess. Bun on macOS loads the system SQLite 3.54.0, and Node bundles SQLite 3.51.3. `PRAGMA foreign_keys = ON` is set too, so a row cannot name a thread that does not exist.

**Step atomicity.** `ThreadStore.transaction` wraps `sql.withTransaction`, and every store method nests inside it as a savepoint. A caller that wants a step's records to commit together wraps the step in it. `store-probe kill-mid-transaction --rounds 10` killed a looping writer at random times and found 3,949 committed steps on Node and 5,530 on Bun, each with all three records. The `--hold` case, killed after three writes and before `COMMIT`, found zero records. On Bun that `--hold` child was not killed. Bun exits once no timer is left, so the child exited with code 0 before the kill, and zero records proved nothing there. The fix round gave the held child a timer and made the probe fail unless the child died from `SIGKILL`. After it, the `--hold` child died from `SIGKILL` on both runtimes with zero records found, and 10 random rounds found 4,057 committed steps on Node and 3,589 on Bun, none incomplete.

**Migrations.** The store runs migration 0001 with `Migrator.make({})` from `effect/sql/Migrator`, not through `#platform`. In `@effect/sql-sqlite-node@4.1.5` and `@effect/sql-sqlite-bun@4.1.5`, `SqliteMigrator.run` is that same `Migrator.make({})` call, with its schema dump commented out. Reaching it through `#platform` would add a member to `Platform` and a dynamic import that runs the same code. The box that names `SqliteMigrator` stays unchecked until the root accepts or rejects this. `Platform` is unchanged.

**Perf, one interleaved run for the owner's confidence.** `store-probe bench-interleaved --rounds 6` alternated Node and Bun, each round on a fresh file database. Each bench does 2,000 single-message appends, each in its own transaction, and 50 reads of 1,000 messages. The load average was 4.97 on 24 cores.

| Runtime | SQLite | Append median of round medians | Range | Read of 1,000, median | Range |
|---|---|---|---|---|---|
| Node 22.22.3 | 3.51.3 | 0.095 ms | 0.091 to 0.096 ms | 1.853 ms | 1.814 to 1.974 ms |
| Bun 1.4.5 | 3.54.0 | 0.149 ms | 0.140 to 0.155 ms | 0.574 ms | 0.565 to 0.579 ms |

The ranges do not overlap. The read gap comes from the driver. A script outside the store ran the same `SELECT` with no Effect code on the same file and took a median 1.12 ms with `node:sqlite` and 0.40 ms with `bun:sqlite`. The store adds a count query, the row mapping, and the Effect calls, about 0.7 ms on Node and 0.17 ms on Bun. The append gap is the `fsync` cost above. With `NORMAL`, the two runtimes were within 0.004 ms. No profiler ran, so the split inside the store's share is not measured.

**Perf after the fix round.** `store-probe bench-interleaved --rounds 10` at the fix-round head, with a load average of 3.4 to 3.7 on 24 cores, gave these medians of the round medians.

| Runtime | Append, first head | Append, fix round | Read of 1,000, first head | Read of 1,000, fix round |
|---|---|---|---|---|
| Node 22.22.3 | 0.097 ms | 0.095 ms | 1.913 ms | 2.189 ms |
| Bun 1.4.5 | 0.152 ms | 0.114 ms | 0.569 ms | 0.795 ms |

The first-head numbers are the verifier's run. To split the read cost, four builds ran 6 alternating rounds each in one session. The builds were the first head, the fix-round head, that head without the read transaction, and that head without the NUL-safe column expressions. Appends showed no measurable difference on either runtime. The first head also measured 0.125 ms on Bun in that session, so the lower Bun append median above is session variance. The read of 1,000 rose from 1.867 ms to 2.212 ms on Node and from 0.573 ms to 0.791 ms on Bun. The NUL-safe column expressions cost about 0.17 ms on Node and 0.14 ms on Bun. The read transaction cost about 0.09 ms on Node and nothing measurable on Bun. The remaining 0.08 to 0.09 ms is the row mapping, which now decodes text and adds the nine `subagent_*` fields. That split comes from removing one change at a time, not from a profiler. Both reads stay far under the 50 ms budget.

**Decisions in the fix round.** An audit and a verifier found five defects and several weak tests. Each store defect has a test in `contract.test.ts` that fails at `56d3c00` on at least one runtime. The NUL defect fails only on Node.

- A tool result belongs to the nearest earlier assistant message in its thread whose `tool_calls` lists its `tool_call_id`. Messages section 6 ties the cascade to "their parent assistant message", and a provider may reuse a call id in a later turn.
- `getMessages` rejects a `limit` or `offset` that is not a non-negative integer with `InvalidMessagesQuery`, instead of clamping it. A negative or fractional value is a caller bug, and clamping would hide it.
- `setValue` and `getValue` reject a key that holds a lone surrogate, and a JSON value may nest at most 1000 levels. `DIVERGENCES.md` documents both caps, as Runtime 14.2 asks.
- The store still rejects a `Date` or a `Map` as a key-value value. It checks the object's tag, not its prototype, so a plain object from another realm passes.
- A lone surrogate in message text still reads back as U+FFFD on both runtimes. The spec gives no cap for message text, so the store neither rejects nor encodes it. This stays open.
- `Effect.provide` reuses a layer that an enclosing provide built, so two nested providers of one store share a connection. The tests wrap each store layer in `Layer.fresh`.

**Where M1-3 differs from this plan.**

- The plan's step box first said a step's assistant message and its tool results commit together. Runtime section 3 orders "Persist assistant response" before "Execute tool calls sequentially", and M1-4 lane 6 needs the assistant message on disk while a tool sleeps. Those two cannot both hold for one step. The fix round rewrote the box to say what the store offers. The caller picks the transaction, M1-4 has to choose, and lane 3 of M1-3 tests only that a transaction is atomic.
- The plan's ledger box asks for `covered` on every M1 entry in Runtime section 14 and every persistence statement of Execution State 4.3. Six of the ten Runtime entries are `covered`. Two are `partial`, because they promise the behavior on `ThreadState` in tools, hooks, and endpoints, which M1-4 and M4 build. Two are permissions and are `not-testable`. In 4.3, two entries are `covered` and two are `partial`, because M1-6 sets and recovers the status. That box stays unchecked.
- `packages/runtime/scripts/` is exempt from the platform import rule, and `tsconfig.json` now type-checks it. The probe spawns and kills processes and reads its arguments.
- The probe imports `#platform`, which resolves to `dist` under plain Node and Bun. Run `pnpm build` before the probe, as the boot recipe does.
- Threads 7.3 points at "Runtime §15" for the key-value semantics, and the Runtime page numbers that section 14. The Runtime page has two sections numbered 14.

### Settled in M1-4

The M1-4 owner ran each command below on 2026-11-26 on macOS, from the repository root, with Node 22.22.3 and Bun 1.4.5. Transcripts are in `/tmp/spindle-m1-4/evidence/` on that machine. The brief `docs/plans/briefs/m1-4.md` corrected this section before the build, and the owner followed it.

**Layout.** `execution/turn.ts` resolves the agent's sides, the prompt, the model, and the offered tools before the first request. `assemble.ts` renders the system prompt and turns history into provider messages. `call.ts` streams one response and keeps per-call state chunk by chunk. `tools.ts` validates, runs, and stores one tool call. `stop-rules.ts` holds the ordered rule table. `thread-state.ts` builds `ThreadState` and is the only file that turns an Effect into a Promise. `step.ts` runs one execution from start to settled, and `trigger.ts` holds `sendMessage`, which stores the human's message and starts the execution. `providers/config.ts` resolves config slots, and `providers/script.ts` answers `--script`. The conformance package has its own `ScriptedProvider`, because a scenario imports nothing from the runtime and the runtime ships no test code.

**Readings taken for part 5 of the brief.** Each line is one reading. The operator can overrule any of them.

1. Malformed arguments. `openaiCompatible` sends no `tool-call-done` for a call whose argument text is not a JSON object. The loop never runs the call, runs its siblings, and stores an error result tied to the call id and name that says the arguments are not a valid JSON object. Messages section 1 says `arguments` is itself JSON-encoded, and the provider types make a call's arguments an object, so the stored `arguments` is the JSON text of `{"invalid_json": "<the raw text>"}`. A later request shows the provider that same object. The fix round of 2026-11-26 settled this. Before it, the loop stored the raw text and replayed an empty object.
2. Stream details. The loop reads `finish.reasoningDetails` and the `extraContent` of a call from the package's chunk type. It stores the details as JSON, so an empty list stays `[]`, and keeps `extraContent` in `metadata.tool_call_extra`. It counts `provider-tool-done`, `web-search-done`, and distinct `image-done` indexes in the run's model call log and never runs them. A response with details records its model definition and native model id in `metadata.reasoning_source`, and a later request supplies those details only when it goes to that same model definition and native model. The loop compares the two fields one by one, so their order in storage does not matter. A seeded message without that record keeps its details in storage and sends none.
3. Partial streams. The first appearance of a call id orders the calls, and `tool-call-done` holds the final arguments. A stream that finishes with `error` fails the attempt. A stream that ends without `finish` was cut off, so it fails the attempt with `server_error`, which is retryable, and `openaiCompatible` ends a wire stream with no finish reason the same way instead of inventing one. A failed attempt stores nothing and runs none of its calls. A response with no tool call and no image whose text is null, empty, or whitespace, a reasoning-only response included, is rejected like a response that breaks `toolChoice`.
4. History. The turn starts at the other side's latest message when the execution starts, and everything before it is past history. `includeChat` admits past text, and `includePastTools` admits past calls together with their results. The current turn is always in the request. `historyLimit` from the package is ignored.
5. Tool results. A success stores `result`. An error stores `error`, then `result` after a blank line. `error_code` and `error_data` go to the message's `metadata`, and `stack` is dropped. Attachment references are stored. Any failure between the tool's return and its stored result becomes a tool error for that call, and the next call runs. The stored error keeps the tool's own error text, result text, and error code, and says what Spindle dropped. A new file (`ToolAttachment`) and an attachment that is neither a reference nor a new file are dropped, and the note for a new file names M3. Error data that the store rejects, such as a circular reference, or that throws when it is read, is dropped. A return value that is not a `ToolResult` becomes an error result, and a thrown value that is not an `Error` is shown as JSON. The second fix round of 2026-11-26 settled this. Before it, a `null` attachment ended the run with `fatal_error`.
6. Stop outcome. The loop resolves `stopTool` from the agent's namespace and compares each call with the name under which the prompt offers that tool, so a qualified name such as `pack/finish` matches a call to `finish`. A name that resolves to no offered tool is compared as written. The first call to `stopTool` in returned order sets the outcome, every call of that step runs first, and a failed stop call still stops the turn. `stopToolResponseProperty` reads that property from the result parsed as JSON before redaction, and the value is `null` when it is absent. A secret inside the property name therefore cannot hide it, and the run outcome reports the value redacted. The M1-5 fix round settled this. Before it, redaction kept property names so that the stored result could be read. The outcome is `stopTool` on the run outcome.
7. Retries and caps. One setting, `retries`, defaults to 2 and covers a retryable provider error, a response that breaks `toolChoice` (no call under `required`, a call under `none`), and a response that returns nothing. Every attempt builds the provider again, so an extension with `createFetch` gets a fresh transport for a retry. A rejected response is not stored and is not a step. A failure gets the retryable code `timeout` when a `TimeoutError`, an undici timeout code, or `ETIMEDOUT` appears in its chain of causes, whichever layer raised it, unless the caller cancelled the request. The delay is `retryAfter` seconds up to 60, or 0.5 seconds doubling. Exhausted retries settle the run as `failed` with `step_error`, and for a response that returns nothing the error says the model returned nothing. The model call log keeps the status code, origin, and upstream of every failed attempt. `maxSteps` counts the side's model steps in one turn. The runtime step cap defaults to 1000 and settles with `max_total_steps`. At 100 it cut short an agent whose `maxSteps` was 200.
8. Usage and metadata. The loop keeps finish usage as the provider gives it, zeros included, and stores no usage on a message. `getResponseMetadata` runs on a forked fiber with a 30 second limit, its result goes to the model call log, and the execution joins every fiber before it settles. `openaiCompatible` reports zeros when the endpoint sends no usage.
9. Options and reasoning. The merge is shallow, model options first and prompt options second, and the later top-level key wins. The request carries the model's `capabilities.reasoningLevels` as `reasoning.levels` when the prompt sets a level. `openaiCompatible` maps the level with `mapReasoningLevel` to `reasoning_effort`, removes `reasoning_effort` when the mapping is `null`, and leaves the options alone when the model declares no levels. It reads reasoning text from `reasoning_content` or `reasoning` and structured reasoning from `reasoning_details`, in OpenRouter's `reasoning.text`, `reasoning.summary`, and `reasoning.encrypted` shape or the package's shape, and joins streamed fragments that share an index. It sends earlier reasoning back as `reasoning_content` and `reasoning_details` in OpenRouter's shape, with each detail's id, format, text, and data in the wire field it was read from. With `exclude`, it returns no reasoning from either method, because chat completions has no common field that asks the model to withhold it.
10. Credentials. The `apiKey` slot of `openaiCompatible` is optional, and an empty key sends no `Authorization` header. Its slots read `OPENAI_API_KEY` and `OPENAI_BASE_URL`. Before the first request the loop learns the secret values of the model's provider config, even when `--script` replaces the provider, and the names of the variables that the config reads as secret. It also learns the name and the value of every variable that the prompt or one of its tools declares secret, and the instance value of every variable they declare. A value a tool reads through `env()` or `instanceEnv()` joins the values. The second fix round of 2026-11-26 replaced the first round's redaction with four rules.
    - A tool result is redacted before it is stored, with a plain replacement of each secret over the whole text. That covers the result text, the error text, `error_data` with its keys, and the name and description of an attachment. Property names in JSON text are not an exception. Redaction is the last step before the store, so it runs after Spindle joins the error text, the result text, and its own notes. The status, the call id, the tool name, the error code, and the id and path of an attachment never change. The M1-5 fix round settled this. Before it, the top-level text of a result was read as JSON and kept its property names, so a secret written as a property name was stored and sent to the model.
    - A message that a tool or a hook injects or edits is redacted before it is stored. Its content and its metadata, keys included, lose every secret. The human's messages are stored as sent.
    - The model's response is stored exactly as returned. That covers its text, reasoning text, reasoning details, and each call's id, name, and arguments. The stored arguments are what the model sent, and the next request shows the provider those same arguments. The tool runs with the result of validating them against its schema, and a schema may transform a value, as `z.string().trim()` trims a string, so the tool can get a value that differs from the stored one.
    - `spindle run` owns the set of secret values, learns the turn's secrets before it prints its first line, and sends every line it prints through one redactor. That covers each output line, the trace, the request dump, the summary line, and every error. The run outcome also carries redacted error messages and model call logs.
    - Each value is found as written and once JSON-escaped, with no length floor. `packages/conformance/DIVERGENCES.md` records what that misses.
11. Variables. The spec's examples show no placeholder syntax, so Spindle interpolates the package's env part, `{ type: 'env', property }`. An env part may name only a variable that the rendered prompt declares with type `text`. The run fails before its first request when a declaration or the provider config marks that name secret, or when the value comes from the runtime instance environment, and the message names the variable. Every instance value is secret, because the operator supplies it and a declaration cannot vouch for it. An agent, prompt, or tool entry default is text unless something marks its name secret. After every include and every substitution, the run also fails when the finished system prompt holds a secret value that the execution knows by then, and the message says that the rendered prompt holds a secret. Before the first request the execution knows the provider config's secret values, the value of every name marked secret, and the instance value of every variable that the prompt or one of its tools declares. The round of 2026-11-26 that fixed the final audit settled the instance rule. Before it, a text variable from the instance reached the system prompt. A declared required variable with no value fails the run before any request. The env and variables of an included prompt are ignored, because only its `prompt` field is included. Thread arguments reach interpolation in M2.
12. Commits. The assistant message commits alone before any tool runs, and each tool result commits alone before the next tool starts. No transaction spans a step.
13. Tool names. A call to a tool the prompt does not offer, or to no tool at all, gets an error result. `invokeTool` reaches function tools only. It allows a target that the calling tool's `uses` list names or resolves to, and returns an error result for any other target. A prompt that lists a prompt tool, an agent handoff, or a provider tool fails before the first request.

**Other choices.** With a human on side A, the human's messages are stored as `assistant` and the model's turns as `user`, and the model still sees its own turns as `assistant`. A message owns its tool results because it lists their call ids, whatever its role, so deleting a side B model turn, stored as `user`, deletes its results too. The store keeps its rule that a result belongs to the nearest earlier message with the same parent that lists its id. An execution settles after the prompt side's turn with a reason code from Execution State section 4.2. A definition or config problem settles as `fatal_error`, and a provider, policy, or store failure as `step_error`. `spindle run` keeps the thread in memory unless `--db` names a file. `ThreadState` members that a later milestone owns reject with a message that names that milestone. `emit` does nothing, because no client connects before M6. Until M3 every attachment reaches the model as a text description.

**The Hello, World fixture.** The three files are the example as written, plus a first line that tells Biome not to format them. Two lines of `agents/models/conversational.ts` change. Line 3, `import { openrouter } from '@standardagents/openrouter';`, becomes `import openrouter from '../providers/spindle_test.ts';`. Line 8, `model: 'anthropic/claude-sonnet-5',`, becomes `model: process.env.SPINDLE_TEST_MODEL ?? 'anthropic/claude-sonnet-5',`. The new file `agents/providers/spindle_test.ts` extends `openaiCompatible` with `SPINDLE_TEST_BASE_URL` and `SPINDLE_TEST_API_KEY`. `/tmp/spindle-m1-4/evidence/hello-world-diff.txt` holds the diff against the spec.

**Effect v4 names.** These come from the `.d.ts` files under `node_modules/effect/dist`.

- `FetchHttpClient.Fetch` from `effect/http` is a `Context.Reference` whose default is the global `fetch`. The runtime passes it as `ProviderFactoryConfig.fetch`, and a test replaces it with `Effect.provideService`.
- `Config.option(Config.String(name))` reads the runtime instance environment. A test replaces it with `ConfigProvider.layer(ConfigProvider.fromEnvRecord(env))`.
- `Effect.runPromiseWith(context)` runs an Effect against the services the execution captured with `Effect.context()`.
- `Effect.tryPromise({ try: (signal) => ..., catch })` passes an `AbortSignal` only when the thunk declares a parameter.
- `Effect.forkChild` and `Fiber.join` run `getResponseMetadata` beside the loop, and `Effect.timeoutOption` bounds it.
- `Cause.hasInterruptsOnly` and `Cause.findError` turn a failure into a run outcome while an interruption stays an interruption.
- `Schema.optionalKey`, `Schema.fromJsonString`, and `Schema.decodeUnknownEffect` decode a `--script` file.

**Live lanes, owner runs.** Each lane ran on Node and on Bun at `40475ed` and passed. `lanes.sh` saved one transcript per lane in `/tmp/spindle-m1-4/evidence/node/` and `/tmp/spindle-m1-4/evidence/bun/`. In lane 2, a second process read the `write_note` result while the second tool slept. In lane 6, `kill -9` during the tool left the user message and the assistant message with its call on disk, and the process exited 137. Lane 10 ran once on each runtime against `claude-haiku-5-5` at `http://localhost:8317/v1`, and the Hello, World fixture ran once on Node. Those three runs sent five requests. The second fix round ran lanes 1 to 9 at `8cc8ad0` on Node and on Bun with the same script, and every pass predicate held. Its transcripts are in `/tmp/m14r2/lanes/`. The verifier's lanes still run at the verdict, so the live and perf boxes of the M1-4 section stay unchecked.

**Perf, owner run.** `node packages/runtime/scripts/step-probe.ts interleaved --rounds 10` alternated Node and Bun. Each round timed one 200-step run of the `bench` agent on a new file database and checked the reason `max_side_steps`, 200 steps, and 401 stored rows. No round failed. The load average was about 3 on 24 cores.

| Runtime | Median per step | Range |
|---|---|---|
| Node 22.22.3 | 0.610 ms | 0.578 to 0.660 ms |
| Bun 1.4.5 | 0.521 ms | 0.505 to 0.578 ms |

Both medians are about 6% of the 10 ms budget. The fix round of 2026-11-26 ran `/tmp/m14fix/scripts/perf.py 10`, which alternates `1a83f21`, the fix head, and the fix head with one secret value loaded, on Node and on Bun, for ten rounds each. The medians were 0.605, 0.607, and 0.610 ms on Node and 0.537, 0.551, and 0.543 ms on Bun, with ranges that overlap, so redaction on every tool result adds no measurable time. All 60 runs took 200 steps and stored 401 rows. The ranges touch at 0.578 ms, so the run does not show that one runtime is faster. A CPU profile of one Node run, not counted above, put the most time in the synchronous SQLite statements of the two commits per step, and the second most in parsing every stored `tool_calls` string again at each assembly, which grows with the history. The second fix round of 2026-11-26 ran `/tmp/m14r2/scripts/perf.py 10`, which alternates `c7268f2` and `8cc8ad0` on Node and on Bun for ten rounds each. The medians were 0.583 and 0.599 ms on Node and 0.524 and 0.518 ms on Bun, with ranges that overlap, so the round adds no measurable time. All 40 runs took 200 steps and stored 401 rows. The bench tool returns plain text and no secret is loaded, so the run measures the path where redaction finds no JSON and no secret. The load average was about 6 on 24 cores.

**Mutation checks.** For 13 covered statements the owner broke the code the statement describes and ran the test the ledger names, and each test failed. `/tmp/spindle-m1-4/mutate.py` holds the edits, and `/tmp/spindle-m1-4/evidence/mutations.txt` holds the runs. The statements are the assistant response persisted before tools, calls run in returned order, arguments validated against the schema, a thrown tool error stored as a result, the other side's calls hidden, `toolChoice` `none` sent with the definitions, `include: false` withholding reasoning, `stopTool` evaluated before step limits, the wait for pending metadata, an include inserted at its location, secrets kept out of `--dump-requests`, a reasoning level replacing the native effort, and `reasoning_details` left `null` when the model returns none.

**Where M1-4 differs from this plan.**

- The plan adds files to the six it names. `turn.ts`, `env.ts`, `call.ts`, `trigger.ts`, `providers/config.ts`, `providers/script.ts`, and `scripts/step-probe.ts` each hold one job named above.
- The conformance package now depends on `@standardagents/spec`, `zod`, and `spindle-runtime`, so that fixtures can import them, and `spindle-runtime` has an `exports` entry.
- The unit box asks for `covered` on Prompts section 5.2. The brief moves those three entries to M2, because they apply to a prompt called as a tool.
- The ledger has 93 more curated statements from part 4 of the brief, and the count line is `606 RFC 2119 statements, 61 lowercase must or should statements, 244 curated statements with no keyword, 24 pages`. After the fix round of 2026-11-26, 233 entries are `covered`, 68 are `partial`, and one more is `planned` for M6, against 86 and 42 before M1-4. The fix round lowered the entries whose tests the coverage audit showed to prove less than they claim, and each partial entry it touched names the milestone that owes the rest.
- Milestones moved by hand. Nine existing `infrastructure:providers` entries for the base provider's config slots, credentials, headers, timeouts, and missing variables moved from M7 to M1. Prompt safety, secret redaction, agent `env`, and function-to-function `uses` moved from M2 to M1. Four Prompts entries for a prompt called as a tool, three of them for requiredSchema, moved from M1 to M2. The new rows for `createFetch`, request-scoped overrides, the agent, prompt, and instance levels of env resolution, and `required` variables start in M1. The new image threshold rows start in M3 and the user-account level of env resolution starts in later.
- The Spindle driver in `packages/runtime/test/spindle-driver.ts` runs each scenario through a `ManagedRuntime`. That is a second place that turns an Effect into a Promise, in test code, at the edge the conformance harness needs.
- Scenario 25 of the brief tests Spindle's own provider, so it lives in `packages/runtime/test/providers/openai-compatible.test.ts` and not in the conformance package.

### Settled in M1-5

The M1-5 owner ran each command below on 2026-11-26 on macOS, from the repository root, with Node 22.22.3 and Bun 1.4.5. Transcripts are in `/tmp/spindle-m1-5/evidence/` on that machine. The brief `docs/plans/briefs/m1-5.md` corrected this section before the build, and the owner followed it.

**Layout.** `execution/hooks.ts` holds `POSITIONS`, one table from each of the thirteen positions to where the loop calls it, what a return value replaces, and what a failure does. It also selects the hook set and runs hooks with the `HookTimeout` limit. `execution/messages.ts` creates and updates a message with its lifecycle hooks and redacts last. `trigger.ts` gains `createThread`, which runs `after_thread_created`, and `stateAtRest`, the `ThreadState` an endpoint would see. `call.ts` reads a progress argument as it streams and starts each call once. `assemble.ts` gains the system prompt check, the set of past message ids, and the converters to and from `LLMMessage`. `step.ts` runs the seven assembly steps and the tool hooks. There is no `snapshot.ts`, because the snapshot is one copy of the live history taken as `filter_messages` starts. The store gains `insertMessage`, which keeps an id and a time that the caller chose and fails with `MessageIdTaken` for an id that any thread holds. The schema did not change.

**Readings taken for part 5 of the brief.** Each line is one reading. The operator can overrule any of them.

1. Identity. The runtime picks a UUID and the current time in microseconds before `before_create_message`, and stores the id and time that the hooks return. An id must be a non-empty string with no lone surrogate, and `created_at` a non-negative safe integer, or the return is invalid. An id that a message already holds fails the write with `MessageIdTaken`, and the first row stays.
2. Refused and essential writes. A failing or invalid `before_create_message` or `before_update_message` hook makes `injectMessage` or `updateMessage` reject with `HookFailed`, which names the hook and holds no content. The human's message, the model's response, and a tool result are writes the execution needs. For them Spindle logs the failure, gives the next hook the last good message, and stores it. When the store refuses what the hooks returned, it stores the message without their changes. A failing `before_store_tool_result` hook keeps the last good result.
3. At rest. `state.execution` is null in `after_thread_created`, in a write outside an execution, and in the create hooks of the human's message, which `sendMessage` stores before the execution starts. The agent's list applies to all three, so a prompt's create hooks never see the human's message. The trigger stays outside the loop.
4. Order. Spindle runs the selected ids of one position in the order the list first names them, and each hook gets the value the hook before it returned. A duplicate id runs once. An invalid return is a failure of that hook. A non-empty prompt list never falls back to the agent's list for a type it lacks.
5. Tool order. `tool_call_started` fires from the stream. Then the tool runs, the tool's own status picks the success or the failure branch once, `before_store_tool_result` runs, the create hooks run on the tool message, and `tool_call_done` gets the stored result after redaction. A failure hook that returns a success result does not switch the branch. A call with invalid arguments or to an unknown tool takes the failure branch. A call that started in a response that failed or that the loop rejected never runs, and its `tool_call_done` gets an error result that says so.
6. Gate and limit. Spindle has no policy gate, and a failing request hook leaves its input in place. One hook call may run 30 seconds, and `spindle run --hook-timeout` or the `HookTimeout` reference sets another limit. A hook past its limit counts as failed, and the log line says that Spindle cannot undo what it does later.
7. Hook types. Spindle calls thirteen positions. `after_subagent_created` hooks resolve and run nowhere before M3. Every hook that gets a message gets the whole `Message`.
8. History. The snapshot is the execution's live history, oldest first, with silent messages and no window. `historyLimit` is ignored.
9. Updates. A returned update holds `content` and `metadata`. A key the hook adds or changes beyond those fails the hook, and a key the caller passed and the hook kept is ignored. `metadata` returned as text that holds a JSON object is read as that object, as Hooks section 8.6 writes it.
10. Nested writes. A hook that injects runs the create hooks again for that message, each call under its own limit. Spindle sets no depth limit.
11. New files. The result hooks see a new `ToolAttachment`, and storage drops it with a note that names M3, as M1-4 does.
12. Request shape. `prefilter_llm_history` gets the history without the system message, in chat completion format, with reasoning as `reasoning_content` and `reasoning_details`. The system message stays first in the request. A message with a role other than system, user, assistant, or tool makes the return invalid.

**Other choices.** A progress argument whose value is not a string starts the call with `progress` undefined. A message that `filter_messages` adds without a known id belongs to the current exchange, so `includeChat` cannot hide it. A field that a hook changes on the human's message or the model's response is redacted like tool output, and every other field of those messages is stored as written. The system prompt check runs after `after_system_message`. A message is on `execution.messageHistory` before its `after_create_message` hooks run. The trace prints the seven assembly steps as seven `assemble` lines.

**Effect v4 names.** These come from the `.d.ts` files under `node_modules/effect/dist`.

- `Context.Reference(key, { defaultValue })` declares `HookTimeout`, and `Layer.succeed` or `Effect.provideService` replaces it.
- `Effect.tryPromise` turns a synchronous throw into a failure, and `Effect.timeoutOption` returns `None` when the limit passes. `Effect.result` keeps both as values.
- `Logger.make` and `Logger.layer` replace the default logger. The driver keeps the lines, and `spindle run` prints them to standard error through the redactor. `Duration.format` prints `500ms`.
- `it.effect` runs on the test clock, so a hook time limit never passes there. The CLI timeout test uses `it.live`.
- `Effect.forkChild` and `Fiber.interrupt` interrupt an execution inside a hook in `test/execution/hooks.test.ts`.

**Live lanes, owner runs.** `/tmp/spindle-m1-5/scripts/lanes.py` ran both "You see" boxes and the ten lanes on Node and on Bun at the head, and every check passed. Lane 1 ran `text-reply.json` and `two-tools.json` on the step-loop fixture at `3020531` and at the head, and the provider requests and the stored messages, without ids and times, were identical. Lane 3 uses the new `packages/runtime/scripts/hook-probe.ts inject`. Lanes 4 and 5 seed earlier messages from an `after_thread_created` hook, and their tool prints `execution.messageHistory`, so each run takes two steps. One real-model run of the `tool_logger` agent against `claude-haiku-5-5` at `http://localhost:8317/v1` called `write_note` once, ran each tool hook once, and stored the result and a final answer. The verifier's lanes still run at the verdict, so the live and perf boxes stay unchecked.

**Perf, owner run.** `/tmp/spindle-m1-5/scripts/perf.py` alternated the parent at `3020531`, the head, and the head with `bench_hooks`, on Node and on Bun, for 10 rounds each. Every run took 200 steps and stored 401 rows. The load average was about 3.4 on 24 cores.

| Runtime | Parent, no hooks | Head, no hooks | Head, 13 no-op hooks |
|---|---|---|---|
| Node 22.22.3 | 0.614 ms (0.595 to 0.711) | 0.687 ms (0.637 to 0.773) | 1.490 ms (1.451 to 1.656) |
| Bun 1.4.5 | 0.544 ms (0.516 to 0.655) | 0.567 ms (0.531 to 0.599) | 1.195 ms (1.146 to 1.248) |

The no-hooks median is 12% above the parent on Node and 4% on Bun, under the 20% rule. The thirteen hooks add 0.80 ms per step on Node and 0.63 ms on Bun, under the 2 ms rule. `bench_hooks` makes 11 hook calls per step, because the bench tool never fails and never updates a message, so the update hooks and the failure hook never run. A second Node session measured 0.590 ms for the parent and 0.632 ms for the head, so the no-hooks gap moves between sessions by about its own size. Removing the id check of `insertMessage` saved 0.006 ms, removing the six new trace lines saved 0.010 ms, and skipping the generator of `runHooks` when no hook is set saved 0.004 ms. One CPU profile per side, not counted above, spent 6 ms more of about 140 ms in the Effect runtime at the head, which fits more Effect steps per loop step. No single change explains the gap.

**Mutation checks.** For 14 covered statements the owner broke the code the statement describes and ran the test the ledger names, and each test failed with an assertion error or, for the time limit, a test timeout. `/tmp/spindle-m1-5/scripts/mutate.py` holds the edits, and `/tmp/spindle-m1-5/evidence/mutations.txt` holds the runs. The statements are the prompt list as the whole set, the agent's list at rest, `after_system_message` before the snapshot, one `filter_messages` call per assembly, the filter's result as the transform's input, silent messages in the snapshot, `null` keeping the system message, the returned message as the inserted one, a failing before hook preventing the creation, a call without a progress argument starting when it appears, a call without its progress argument starting when it is done, `null` keeping a tool result, `tool_call_done` for a failed call, and the hook time limit.

**Where M1-5 differs from this plan.**

- The Files box names `snapshot.ts`, which does not exist. `messages.ts`, `trigger.ts`, `call.ts`, `step.ts`, `ThreadStore.ts`, `sqlite.ts`, `cli/run.ts`, `scripts/hook-probe.ts`, and `scripts/step-probe.ts` changed too, each for one job named above. That box stays unchecked.
- The scenario boxes follow the brief. `messages.ts` holds M1 to M7 and M7b, and `hooks.ts` holds H8 to H22 for the brief's scenarios 8 to 16 and 18. Scenario 17, the policy gate, is not built, because the brief recommends a gate only with an operator policy and none exists. Scenario 19 is not built, because its three statements bind hook authors and it would test fixture code, not Spindle. Those statements are `not-testable`.
- The log line of a failed hook leaves out the hook's error text as well as its arguments.
- The ledger box asks for `covered` on Hooks sections 3 to 5, the Messages page, and Execution State section 2.2. 91 entries became `covered` and 3 became `partial`. Hooks entries that bind authors are `not-testable`, the broadcasts of Hooks section 5 stay with M6, and the queue rows of Messages section 4 stay with M1-6. That box stays unchecked. The ledger holds 324 `covered` and 56 `partial` entries, against 233 and 68 before M1-5.
- Part 4 of the brief lists 18 statements. 14 were already in the list, so 4 were added, and the count line is `606 RFC 2119 statements, 61 lowercase must or should statements, 248 curated statements with no keyword, 24 pages`. Of its three milestone corrections, `hooks:8e371f2b` moved from M3 to M1, and `agents:c51baf9f` and the pair `runtime:43bbb05d` and `runtime:853d2427` already had the milestones the brief asks for.
- The `--trace` test of M1-4 now collapses repeated phases, because the assemble phase prints seven lines.

## Appendix B. Alternatives rejected

- **Cloudflare Workers as the host.** The one existing runtime already covers Workers, and its license forbids production use off its own hosting. The operator chose self-hosted.
- **Node and Workers adapters from the first PR.** Two hosts double the store, the scheduler, and the sandbox work before anything runs.
- **Bun only.** Node users could not embed Spindle. The platform modules give Bun its own primitives without that cost.
- **A runtime check such as `typeof Bun`.** It forces one file to import both platforms. Import conditions pick the module at resolution time, and the probe in Appendix A shows that they work.
- **`better-sqlite3`.** It is a native addon. The Effect v4 Node package uses the built-in `node:sqlite` module.
- **An in-memory store adapter.** The SQLite store on an in-memory database does the same job with one implementation.
- **Plain async TypeScript without Effect.** The operator chose Effect v4. Interruption, layers, and a test clock map onto stop, terminate, platform selection, and scheduled effects.
- **Effect Schema for tool arguments.** `@standardagents/spec` types tool arguments with Zod 4, so tool arguments stay in Zod. Spindle's own records and config use Effect Schema.
- **Redefining the spec types.** `@standardagents/spec` is MIT and exports them.
- **Builder as a test oracle.** The operator chose clean room.
- **Full 0.2.0 conformance before any release.** The operator chose core first.
- **One plan file for every milestone.** Later PRs depend on what milestone 1 teaches, so ten-lane detail for them now would be invented.
- **Vendoring the spec markdown.** `spec.lock.json` pins the commit and `requirements.json` holds the extracted statements.

## Appendix C. Risks

- **Effect v4 knowledge is thin.** Version 4.0.0 is eight weeks old, and most written examples describe v3. M1-1 carries the risk first. Each owner reads the installed type declarations, and the gates lane runs `tsc`.
- **The Promise edge is wide.** `ThreadState` has more than fifty members, and every one crosses from user code into Effect. M1-4 carries the risk. The owner builds `ThreadState` in one file and watches that no other file calls `Effect.runPromise`.
- **`node:sqlite` is experimental on Node 22.** M1-3 carries the risk. The owner watches for the warning in CLI output and for API changes on Node 24.
- **The types package and the spec text can disagree.** `@standardagents/spec` is at 0.45.13 and already has members the 0.2.0 text does not require. Every PR carries the risk. `DIVERGENCES.md` records each case, and the operator decides which cases to file upstream.
- **The requirement count is a floor.** A keyword search misses a requirement with no keyword, and only the Runtime, Hooks, Messages, and Agents pages have been read for such requirements. Every PR carries the risk. Each owner adds a curated entry for each such requirement in the sections the PR implements, so the count grows with each PR.
- **The requirement list has known gaps.** Two audits of M1-1 left these open, because none of them affects a milestone 1 test. M3 carries the first one and the milestone that implements each page carries the rest.
  - The curated quotes for Runtime lines 124, 177, and 200 leave out the condition that the spec puts in front of them.
  - Execution State lines 113 and 114 each repeat a client duty from the sentence above their table.
  - The nine example provider names on the Providers page are MAY entries. On the Client API page and the Decisions page, one sentence became the lead-in for a table that it does not introduce.
  - The extractor drops the step number of a numbered list item and the column names of a table row.
  - One test may back 8 requirement ids, so 9 unrelated ids can still pass with two tests. The spec audit of each PR is the control for relevance.
- **The spec moves.** A new spec commit changes requirement ids. M1-1 carries the risk. The `--check` flag fails until someone reviews the added and removed ids.
- **The spec assumes Durable Objects in places.** M1-6 carries the risk. The lease and the recovery pass give the same guarantee, and lanes 5, 7, and 8 test it.
- **No control skill drives the command line.** Every live block carries the risk. Lanes use the shell, and each transcript holds the command and the exit code.
- **Lane 10 of M1-4 and of M1-7 needs a model endpoint.** Without `SPINDLE_TEST_BASE_URL` the lane reports `BLOCKED` and neither PR can get a clean verdict. The operator supplied a local server. Each lane sets `SPINDLE_TEST_BASE_URL` to `http://localhost:8317/v1`, `SPINDLE_TEST_MODEL` to `claude-haiku-5-5`, and `SPINDLE_TEST_API_KEY` from `ANTHROPIC_API_KEY` at run time. No brief, transcript, or file holds the key.
- **The perf budgets are guesses.** No measurement exists yet. Each owner replaces a budget only with a measured number and a stated reason, per `benchmark-checklist`.
- **Ten live lanes per PR cost many agent runs.** Seventy lanes run across the seven PRs. The operator can lower the count, and the check script would then need the same change.
- **The operator's review can change the file layout.** A large restructure makes a verdict stale. For that reason only M1-1 gets a full swarm before the review.
- **Clean-room discipline depends on briefs.** The second audit lane checks each diff and each transcript for a path inside a proprietary package.
- **The provider packages are licensed for conforming runtimes.** Spindle does not bundle them. `openai-compatible.ts` gives milestone 1 a provider that Spindle owns.

## Appendix D. Links and reading list

- The specification is at [standardagentspec.org](https://standardagentspec.org/), and its source is the [standardagents/spec repository](https://github.com/standardagents/spec). Read `content/0.2.0/infrastructure/runtime.md` before any PR.
- M1-2 reads `distribution/packaging.md`, `specification/agents.md`, `specification/handlers.md`, `specification/prompts.md`, and `specification/models.md`.
- M1-3 reads `specification/threads.md` section 7 and `specification/threads/execution-state.md` section 4.
- M1-4 reads `specification/tools.md`, `specification/prompts.md`, and `specification/providers.md`.
- M1-5 reads `specification/hooks.md` and `specification/threads/messages.md`.
- M1-6 reads `specification/handlers.md` section 4 and `specification/threads/execution-state.md`.
- M1-4 and M1-6 get `<pstack>/skills/how/SKILL.md` before the build and `<pstack>/skills/interrogate/SKILL.md` before the verdict.
- The root keeps a decision trail per `<pstack>/skills/show-me-your-work/SKILL.md` and commits it under `docs/plans/trail/`.

## Appendix E. Later milestones

Each milestone gets its own plan file when the one before it lands. The first four make up version 1.

| Milestone | Scope | Spec pages |
|---|---|---|
| M2 | Handler sides, two prompt sides, session tools, handoff tools, prompt tools, and thread environment values. | Agents, Handlers, Prompts, Threads sections 2 and 6 |
| M3 | The thread filesystem and subagents, with attachment copying and parent hooks. | Filesystem, Subagents, Runtime sections 7 and 8 |
| M4 | Scheduled effects, `decide()`, thread endpoints, and an HTTP server on `NodeHttpServer` and `BunHttpServer`. | Effects, Decisions, Endpoints |
| M5 | `runCode` in a sandbox. A prototype picks the engine first. | Code Execution, Runtime first section 14 |
| M6 | The Thread Client API over HTTP and WebSocket, tested with the official client. | Client API |
| M7 | Model fallbacks and pricing, type registry generation, agent skills, and runtime streams. | Models, Type Registry, Threads section 7.4, Runtime Streams |
| Later | Users, when the page leaves Draft. | Users |
