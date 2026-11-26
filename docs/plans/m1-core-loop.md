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

The program runs `<pstack>/skills/poteto-mode/playbooks/autopilot-stack.md`, where `<pstack>` is `~/.claude/plugins/cache/cursor-plugins/pstack/0.15.34`. Owners build and verify. The root chains the PRs into one stack. The operator reviews and lands the stack bottom-up. M1-2, M1-4, and M1-7 are review-gated and stop at merge-ready.

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

- [ ] Spawn one owner per PR as `subagent_type: "pstack:poteto-agent"` with the full lifecycle that `autopilot-stack.md` names. No `~/.claude/rules/pstack-models.md` exists, so code owners run on the session model. Give M1-4 and M1-6 `model: "opus"` with `effort: "xhigh"`, because the step loop and the concurrency rules are the hardest changes.
- [ ] Put these three rules in every owner brief.
  - [ ] Clean room. Read the spec text and `@standardagents/spec` only. Never open a file inside `@standardagents/builder`, `@standardagents/cloudflare`, or any other proprietary Standard Agents package. Never install `@standardagents/builder`.
  - [ ] Effect v4 from the installed package. Read the type declarations under `node_modules/effect` and `node_modules/@effect/*` before you write a call. Do not write Effect v3 names from memory. `@effect/platform` and `@effect/sql` stopped at 0.x and are not dependencies.
  - [ ] Spec text decides behavior and `@standardagents/spec` decides signatures. Record each disagreement in `packages/conformance/DIVERGENCES.md`.
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

### Verdict and merge, for every PR

- [ ] A full swarm runs once, at the code-ready head. Another full swarm runs only for new behavior, a redesign, or a large new diff. A rebase, a merge-conflict resolution, or a minor fix gets a single verifier at the new head. Run each full swarm per `<pstack>/skills/swarm/SKILL.md`. One gates lane runs `pnpm check` on Node and on Bun. The ten live lanes come from the PR's **Verify, live** block. The perf lane comes from its **Verify, perf** block. Two audit lanes read the diff and the receipts and distrust the PR body. One audit lane checks the diff against the spec text for the ledger entries the PR marks `covered`. The other audit lane checks the clean-room rule and the platform import rule.
- [ ] Clean only when every lane is `PASS`. A lane that cannot run reports `BLOCKED`, and `BLOCKED` is not `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh verdict, except for results that stay valid under the patch-id rule in `shipping.md`.
- [ ] The owner reports STACK-READY. The root appends the PR to the stack in dependency order with `gh pr edit <pr> --base <parent-branch>`. The operator lands the stack bottom-up.

### Boot recipe, for every live lane

Each live lane runs in its own git worktree at the PR head. The `control-cli` skill is not installed, so each lane drives the command line through the shell.

- [ ] `git fetch origin <head-branch> && git worktree add /tmp/swarm-<pr-id>/worker-<n>/tree <head SHA>`.
- [ ] Run `pnpm install --frozen-lockfile && pnpm build` in the worktree. Wait for exit code 0.
- [ ] Give each lane its own database file at `/tmp/swarm-<pr-id>/worker-<n>/spindle.db`. Never share a database file between lanes.
- [ ] Run the lane's commands exactly as written. Read state only through `spindle` output, the probe script, or `sqlite3 <db> "<select>"`.
- [ ] Save every transcript to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.txt` with the command, the exit code, and the full output. Return the paths with the report.

## Set up the workspace and the requirement ledger (M1-1)

The ledger is a JSON map from requirement id to `{ status, milestone, tests, reason }`. The status is one of `covered`, `planned`, `deferred`, and `not-testable`. A requirement id is the page name plus a hash of the section and the statement text, so a spec edit shows up as one removed id and one added id.

**Depends on.** None.

**Files.**

- [ ] Create `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`, and `.github/workflows/ci.yml`.
- [ ] Create `packages/runtime/package.json` with the `spindle` bin and an `imports` entry for `#platform` that has a `bun` condition and a `default` condition.
- [ ] Create `packages/runtime/src/platform/node.ts`, `packages/runtime/src/platform/bun.ts`, and `packages/runtime/src/cli/main.ts`.
- [ ] Create `packages/conformance/package.json`, `packages/conformance/spec.lock.json`, `packages/conformance/requirements.json`, `packages/conformance/ledger.json`, and `packages/conformance/src/ledger.ts`.
- [ ] Edit `scripts/spec-requirements.mjs` so that it reads the spec commit from `spec.lock.json`, fetches the spec only under `--refresh`, and exits non-zero under `--check` when its output differs from `requirements.json`.
- [ ] Create `AGENTS.md` with the three owner-brief rules, and symlink `CLAUDE.md` to it.
- [ ] Edit `README.md`.

**Build.**

- [ ] Add `effect`, `@effect/platform-node`, `@effect/platform-bun`, `@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, and `@standardagents/spec` to `packages/runtime`. Add `vitest` and `@effect/vitest` as dev dependencies. Pin every Effect package to the same exact version.
- [ ] Export one `PlatformLive` layer and one `runMain` function from each platform module. `node.ts` builds them from `NodeServices`, `NodeRuntime`, and the `SqliteClient` of `@effect/sql-sqlite-node`. `bun.ts` builds them from `BunServices`, `BunRuntime`, and the `SqliteClient` of `@effect/sql-sqlite-bun`.
- [ ] Make `packages/runtime/src/cli/main.ts` import `PlatformLive` and `runMain` from `#platform` and print the package version, `SPEC_VERSION`, and the platform name for `spindle --version`.
- [ ] Add a Biome `noRestrictedImports` rule. Only files under `packages/runtime/src/platform/` may import `@effect/platform-node`, `@effect/platform-bun`, `@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, a `node:` module, or a `bun:` module.
- [ ] Settle how the test suite runs under Bun. Try `bun --bun vitest run` first. If the Vitest version that `@effect/vitest` requires does not run under Bun, run the platform contract tests with `bun test` and record the result in Appendix A.
- [ ] Pin the spec at commit `f462a673297faed1f849ef1741ddda1e06b6c817` in `spec.lock.json` and generate `requirements.json`.
- [ ] Write `packages/conformance/src/ledger.ts`. It fails when a requirement id has no ledger entry, when a `covered` entry names no test, when a named test does not exist, and when a ledger id is absent from `requirements.json`.
- [ ] Fill `ledger.json` with one entry per id. Mark every `specification:users` entry `deferred` with the reason that the page is a Draft. Mark every other entry `planned` with its milestone from Appendix E.
- [ ] Add the `pnpm check` script. It runs Biome, `tsc --noEmit`, Vitest, the ledger check, and `scripts/spec-requirements.mjs --check`.
- [ ] Run `pnpm check` in CI on Node 22, on Node 24, and on Bun.

**You see.**

- [ ] `pnpm check` exits 0 and its last line reads `ledger ok, 512 requirements, 0 covered`.
- [ ] `node scripts/spec-requirements.mjs --check` prints `458 RFC 2119 statements, 54 lowercase must or should statements, 24 pages`.
- [ ] `node packages/runtime/dist/cli/main.js --version` prints `platform node`, and `bun packages/runtime/dist/cli/main.js --version` prints `platform bun`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/conformance/test/ledger.test.ts` gains one case for each of the four ledger failures. Run `pnpm vitest run packages/conformance/test/ledger.test.ts`.
- [ ] `packages/runtime/test/platform.test.ts` gains a case that opens an in-memory SQLite database through `PlatformLive` and reads back one row. Run it on Node and on Bun.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

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

- [ ] Create `packages/runtime/src/registry/Registry.ts`, `load-directory.ts`, `load-packages.ts`, `resolve.ts`, and `validate.ts`.
- [ ] Create `packages/runtime/src/cli/validate.ts`.
- [ ] Create `packages/conformance/fixtures/agents-basic/`, `packed-a/`, `packed-b/`, and `scoped-pkg/`, and one fixture directory per invalid case under `packages/conformance/fixtures/invalid/`.

**Build.**

- [ ] Define `Registry` as an Effect service. Its layer needs `FileSystem` and `Path` and nothing platform-specific.
- [ ] Load unpacked definitions from the default exports of the files under `agents/agents`, `agents/prompts`, `agents/tools`, `agents/models`, `agents/hooks`, `agents/handlers`, and `agents/effects`. Import each `.ts` file directly. Node 22.22 and Bun both strip types on import.
- [ ] Discover packed packages by the `standardagent` field in each `package.json` under `node_modules`, and under `agents/packed/`. Import each package, read `__meta`, and attach a `PackageSignature` to every definition at load time.
- [ ] Implement `resolve` with `parseQualifiedName` and `isVisibleInNamespace` from `@standardagents/spec`, including scoped package ids.
- [ ] Validate at load time. Call `validateAgentDefinition` from `@standardagents/spec`. Add the checks the spec text requires that the function does not cover, which the owner finds by reading Agents section 8, Handlers section 2, Subagents section 2.4, Prompts sections 2.4, 3.4, and 9, Models section 6, and Hooks section 1.2.
- [ ] Add `spindle validate [dir]`. It prints one line per issue as code, severity, path, and message. It exits 1 when any issue has severity `error`. `--json` prints the issue list as JSON. `--list` prints every resolved qualified name by kind.

**You see.**

- [ ] `spindle validate packages/conformance/fixtures/agents-basic` exits 0 and prints the count of agents, prompts, tools, models, hooks, handlers, and effects.
- [ ] `spindle validate packages/conformance/fixtures/invalid/both-sides-human` exits 1 and prints one issue line with a code from `DEFINITION_ISSUE_CODES`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/runtime/test/registry/resolve.test.ts` gains one case per cell of the visibility table and one case per qualified-name form. Run `pnpm vitest run packages/runtime/test/registry`.
- [ ] `packages/runtime/test/registry/validate.test.ts` gains one case per invalid fixture. Each case asserts the issue code and the path.
- [ ] The ledger entries for `distribution:packaging` and for the definition-time statements in `specification:agents`, `specification:handlers`, `specification:prompts`, `specification:models`, and `specification:hooks` change to `covered`. Run `pnpm check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

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

- [ ] Create `packages/runtime/src/store/ThreadStore.ts`, `schema.ts`, `migrations/0001_threads.ts`, and `sqlite.ts`.
- [ ] Create `packages/runtime/scripts/store-probe.ts`.
- [ ] Edit `packages/runtime/src/platform/node.ts` and `packages/runtime/src/platform/bun.ts` only if the store needs a `SqliteClient` option that M1-1 did not set.

**Build.**

- [ ] Define `ThreadStore` as an Effect service whose methods return typed records and typed errors. The live layer needs `SqlClient` from `effect/sql/SqlClient` and names no SQLite package.
- [ ] Write one implementation. Tests use the same implementation on an in-memory database. Do not add a second adapter.
- [ ] Run migrations with the `SqliteMigrator` module of the platform's SQLite package, reached through `#platform`.
- [ ] Write every step's records in one transaction. A step's assistant message and its tool results commit together or not at all.
- [ ] Implement the durable key-value rules from the second section 14 of the Runtime page. `setValue` with `null` or `undefined` deletes the key. `getValue` returns `null` for a key that was never set. A thread cannot read another thread's keys. A value that JSON cannot represent makes `setValue` fail with an error that names the key.
- [ ] Implement message reads with `includeSilent`, a stable order by sequence number, and the paging options of `GetMessagesOptions`.
- [ ] Change the `since` time of the run status only when the state or the reason changes.
- [ ] Write `store-probe.ts` with one subcommand per live lane. Each subcommand prints what it wrote or read as JSON.

**You see.**

- [ ] `node packages/runtime/scripts/store-probe.ts roundtrip --db /tmp/x.db` prints three message records in order, and a second process prints the same three.
- [ ] `sqlite3 /tmp/x.db ".tables"` lists `threads`, `messages`, `queue`, and `kv`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/runtime/test/store/contract.test.ts` gains one case per `ThreadStore` method and one case per key-value rule. Run `pnpm vitest run packages/runtime/test/store` on Node and on Bun.
- [ ] The ledger entries for the second section 14 of `infrastructure:runtime` and for the persistence statements in `specification:threads/execution-state` section 4.3 change to `covered`. Run `pnpm check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. The parent branch has no store, so record that. At the head, run the `roundtrip` probe, then read the database from a new process. Save `roundtrip.txt`. Pass when both processes print the same three records in the same order.
- [ ] Lane 2. Append one message, send `SIGKILL` to the process after the append resolves, and read from a new process. Save `kill-after-append.txt`. Pass when the message is present.
- [ ] Lane 3. Send `SIGKILL` to the process inside a step transaction that writes one assistant message and two tool results. Save `kill-mid-transaction.txt`. Pass when the new process finds all three records or none of them.
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

An execution moves through one ordered list of phases per step, which are drain, assemble, call, persist the response, run the tools, persist the results, and evaluate the stop rules. The loop records each phase in an `ExecutionTrace`. The stop rules are one ordered table that the loop reads top to bottom. User code is Promise-based and runs at the edge. The loop wraps each tool call in an Effect and builds the `ThreadState` object from the services the execution holds.

**Depends on.** M1-2 and M1-3.

**Files.**

- [ ] Create `packages/runtime/src/execution/step.ts`, `assemble.ts`, `tools.ts`, `stop-rules.ts`, `trace.ts`, and `thread-state.ts`.
- [ ] Create `packages/runtime/src/providers/openai-compatible.ts`.
- [ ] Create `packages/runtime/src/cli/run.ts`.
- [ ] Create `packages/conformance/src/ScriptedProvider.ts`, `packages/conformance/src/RuntimeDriver.ts`, and `packages/conformance/src/scenarios/step-loop.ts`.

**Build.**

- [ ] Define `RuntimeDriver` in the conformance package. A driver creates a thread, sends a message, waits for the run to settle, reads messages, and returns the provider requests. Every scenario uses the driver and imports nothing from `packages/runtime`.
- [ ] Write `ScriptedProvider` against `LLMProviderInterface` from `@standardagents/spec`. A script lists the responses in order, as text, tool calls, stream chunks, or errors. The provider records each request it receives.
- [ ] Assemble the context. Interpolate the system prompt with its includes and variables, map the prompt side's own turns to `assistant` and the other side's turns to `user`, and convert the history to provider messages.
- [ ] Call the model through the provider's stream, and persist the assistant message with its reasoning fields before any tool runs.
- [ ] Generate each tool's JSON Schema from its Zod arguments, validate the model's arguments against the schema, and run the tool calls one at a time in the order the model returned them.
- [ ] Persist a tool error as a tool result and continue the loop.
- [ ] Evaluate `stopTool`, then `stopOnResponse`, then `maxSteps`, from the one stop-rule table. Pass `toolChoice` through, including `none` with the tool definitions.
- [ ] Write `openai-compatible.ts` against `LLMProviderInterface` for the chat completions wire format. It reads the base URL and the key from provider config slots.
- [ ] Export the provider from `packages/runtime` as a factory named `openaiCompatible`, so that a file under `agents/models/` can import it and pass it as `provider`.
- [ ] Copy the Hello, World example from the spec's Examples page into `packages/conformance/fixtures/hello-world/`. Change only the provider import in `agents/models/conversational.ts`.
- [ ] Add `spindle run <agent> -m <text>`. It loads the `agents/` folder of the current directory, and `--dir <path>` names a different project directory. `--script <file>` selects the scripted provider. `--trace` prints the phase trace. `--dump-requests` prints each provider request as JSON. `--db <file>` selects the database.

**You see.**

- [ ] `spindle run assistant -m "hello" --script text-reply.json --db /tmp/x.db` prints the assistant text and exits 0.
- [ ] `spindle run assistant -m "hello" --script text-reply.json --trace` prints the phases in the order drain, assemble, call, persist-response, tools, persist-results, stop.
- [ ] `spindle run assistant --dir packages/conformance/fixtures/hello-world -m "What does idempotent mean?"` prints a reply from the model at `SPINDLE_TEST_BASE_URL`.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/conformance/src/scenarios/step-loop.ts` gains one scenario per statement in sections 3, 4, 5, and 6 of the Runtime page that this PR covers. `packages/runtime/test/conformance.test.ts` runs every scenario through the Spindle driver. Run `pnpm vitest run packages/runtime/test/conformance.test.ts` on Node and on Bun.
- [ ] `packages/runtime/test/execution/stop-rules.test.ts` gains one case per row of the stop-rule table and one case per pair of rows that can both match.
- [ ] The ledger entries for those statements, and for the statements in `specification:tools` section 9 and `specification:prompts` sections 4.2 and 5.2, change to `covered`. Run `pnpm check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

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

The spec defines fourteen hooks, and this PR implements thirteen of them. The hook positions are one table from `HookName` to where the loop calls it, what the return value replaces, and what a failure does. The loop reads the table. No phase has its own hook code. A context assembly owns one history snapshot, and a message that arrives after the snapshot starts belongs to the next assembly.

**Depends on.** M1-4.

**Files.**

- [ ] Create `packages/runtime/src/execution/hooks.ts` and `packages/runtime/src/execution/snapshot.ts`.
- [ ] Edit `packages/runtime/src/execution/assemble.ts`, `tools.ts`, and `thread-state.ts`.
- [ ] Create `packages/conformance/src/scenarios/hooks.ts` and `packages/conformance/src/scenarios/messages.ts`.

**Build.**

- [ ] Resolve the hook set of the active prompt and agent, with unique ids, in declaration order.
- [ ] Run the seven assembly steps in the order that section 4 of the Runtime page gives. Call `filter_messages` exactly once per assembly, on a stable snapshot that includes silent messages.
- [ ] Keep the output of `filter_messages` and of `prefilter_llm_history` inside the request. `execution.messageHistory` lists the persisted records only.
- [ ] Implement `injectMessage` on `ThreadState`. It runs `before_create_message` and `after_create_message`, resolves after the record is readable through `getMessage`, and never restarts an assembly.
- [ ] Call `before_update_message` and `after_update_message` around every update.
- [ ] Call the five tool hooks at the positions that section 5 of the Hooks page gives. `tool_call_started` and `tool_call_done` each run exactly once per tool call.
- [ ] Call `after_thread_created` when a thread is created. `after_subagent_created` waits for M3.
- [ ] Give each hook call a timeout from one config value, and log a hook failure without the hook's arguments.

**You see.**

- [ ] `spindle run assistant -m "hello" --script text-reply.json --trace` on the hooks fixture prints `after_system_message`, `snapshot`, `filter_messages`, `transform`, `prefilter_llm_history`, and `dispatch` in that order.
- [ ] The same run prints `filter_messages` once per model call.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `packages/conformance/src/scenarios/messages.ts` gains the seven scenarios from section 7 of the Messages page, one scenario per table row. Run `pnpm vitest run packages/runtime/test/conformance.test.ts` on Node and on Bun.
- [ ] `packages/conformance/src/scenarios/hooks.ts` gains one scenario per statement in sections 3, 4, and 5 of the Hooks page.
- [ ] The ledger entries for `specification:hooks` sections 3 to 5, `specification:threads/messages`, and `specification:threads/execution-state` section 2.2 change to `covered`. Run `pnpm check`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

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
- [ ] Wire `execution.stop()` and `execution.abortSignal` to fiber interruption. A stopped run settles to `idle` with a stop reason.
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

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the text-reply script with `--trace` at the parent branch and at the head. Save `single-run-regression.txt`. Pass when the phase traces and the persisted messages are identical.
- [ ] Lane 2. Call `queueMessage` on an idle thread through the probe. Save `queue-idle.txt`. Pass when an execution starts without a send and the status goes `running` then `idle`.
- [ ] Lane 3. Queue a message while a slow tool runs. Save `queue-active.txt`. Pass when the second provider request holds the queued message.
- [ ] Lane 4. Queue two messages and one tool call during a slow tool. Save `queue-fifo-live.txt`. Pass when the trace shows the three entries drained in arrival order.
- [ ] Lane 5. Start `spindle send` to one thread from two processes at the same moment. Save `two-processes.txt`. Pass when the trace shows the first execution settled before the second one started.
- [ ] Lane 6. Send to two different threads at the same moment, each with a slow tool. Save `two-threads.txt`. Pass when the two executions' time ranges overlap.
- [ ] Lane 7. Send `SIGKILL` to the process during a run, then start a new process. Save `execution-lost.txt`. Pass when the status is `failed` with reason `execution_lost` and no thread is `running`.
- [ ] Lane 8. Send a new message to the thread from lane 7. Save `recover-after-loss.txt`. Pass when the status goes `running` then `idle` and the earlier messages are still present.
- [ ] Lane 9. Stop an execution during a slow tool that watches `abortSignal`. Save `stop-during-tool.txt`. Pass when the tool observed the abort and the status settles to `idle` with a stop reason.
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

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `inherit-parent` at the PR head, per the boot recipe.

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
| How many normative statements does spec 0.2.0 hold? | 458 statements with an RFC 2119 keyword and 54 with a lowercase "must" or "should", on 24 pages, with 512 unique ids. | `node scripts/spec-requirements.mjs <spec>/content/0.2.0` at spec commit `f462a67`. |
| Is Effect v4 stable? | `effect@4.1.5` is the `latest` tag. Version 4.0.0 was published on 2026-10-01. | `npm view effect dist-tags time`. |
| Do the Effect platform modules this plan names exist? | `@effect/platform-node@4.1.5` ships `NodeRuntime`, `NodeServices`, and `NodeHttpServer`. `@effect/platform-bun@4.1.5` ships `BunRuntime`, `BunServices`, and `BunHttpServer`. Both SQLite packages ship `SqliteClient` and `SqliteMigrator`. | The file index of each package on unpkg. |
| Does the Node SQLite package need a native addon? | No. `@effect/sql-sqlite-node@4.1.5` imports `node:sqlite` and has `effect` as its only dependency. | The import list of its `dist/SqliteClient.js`. |
| Does `node:sqlite` work on the installed runtimes? | Yes on both. Node prints an `ExperimentalWarning`. | A one-line script that opens an in-memory database. |
| Can one package pick the Node module or the Bun module without a runtime check? | Yes. An `imports` entry with a `bun` condition and a `default` condition resolved to the Bun file under Bun and to the Node file under Node. | A three-file probe in `/tmp/spindle-cond-probe`. |
| Does Node import `.ts` files directly? | Node 22.22.3 reports `process.features.typescript` as `strip`. | `node -e`. |

These questions stay unproven.

- Whether the Vitest version that `@effect/vitest@4.1.5` requires runs under Bun. M1-1 settles it.
- Whether the Bun store is faster than the Node store. M1-3 measures both. Until then "faster" is a guess.
- Whether `@standardagents/openai` loads under plain Node. The permission classifier blocked the probe that installs and imports it.
- Whether the official `@standardagents/client` works against Spindle. A later milestone builds the Thread Client API.
- The exact names of the layers and functions inside the Effect v4 modules. This session read file names only.
- The lowest Node 22 release that strips types without a flag. M1-1 lane 2 sets `engines` from a measured run.

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
- **The spec moves.** A new spec commit changes requirement ids. M1-1 carries the risk. The `--check` flag fails until someone reviews the added and removed ids.
- **The spec assumes Durable Objects in places.** M1-6 carries the risk. The lease and the recovery pass give the same guarantee, and lanes 5, 7, and 8 test it.
- **No control skill drives the command line.** Every live block carries the risk. Lanes use the shell, and each transcript holds the command and the exit code.
- **Lane 10 of M1-4 and of M1-7 needs a model endpoint.** Without `SPINDLE_TEST_BASE_URL` the lane reports `BLOCKED` and neither PR can get a clean verdict.
- **The perf budgets are guesses.** No measurement exists yet. Each owner replaces a budget only with a measured number and a stated reason, per `benchmark-checklist`.
- **Ten live lanes per PR cost many agent runs.** Seventy lanes run across the seven PRs. The operator can lower the count, and the check script would then need the same change.
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
