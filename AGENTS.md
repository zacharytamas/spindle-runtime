# Agent instructions

Spindle is a self-hosted runtime for Standard Agent Specification 0.2.0, written in TypeScript on Effect v4.

## Follow three rules

1. Work clean room. Implement only from the spec text and the MIT package `@standardagents/spec`. Never install `@standardagents/builder`. Never open a file inside `@standardagents/builder`, `@standardagents/cloudflare`, `@standardagents/openai`, `@standardagents/openrouter`, or any other proprietary Standard Agents package.
2. Write Effect v4 from the installed package. Read the type declarations under `node_modules/effect` and `node_modules/@effect/*` before you write a call. Most Effect examples describe v3, and v3 names are wrong for v4. `@effect/platform` and `@effect/sql` stopped at 0.x and are not dependencies.
3. Let the spec text decide behavior and let `@standardagents/spec` decide signatures. Record each disagreement in `packages/conformance/DIVERGENCES.md`.

## Keep platform code in one folder

Core code imports Effect services only. Only files under `packages/runtime/src/platform/` may import `@effect/platform-node`, `@effect/platform-bun`, `@effect/sql-sqlite-node`, `@effect/sql-sqlite-bun`, a `node:` module, `bun`, or a `bun:` module, and only they may use the `process`, `Bun`, and `Buffer` globals. Biome enforces this rule for `packages/runtime`. Other code gets the platform module through the `#platform` import, which picks `bun.ts` under Bun and `node.ts` everywhere else.

## Run the checks

- `pnpm check` runs Biome, `tsc`, Vitest, the requirement check, and the ledger check. `bun --bun run check` runs the same steps under Bun.
- `pnpm test` runs the tests on Node. `bun --bun run test` runs them on Bun. Each result line names the runtime, as in `|bun|`.
- `pnpm build` writes `packages/runtime/dist`. `node packages/runtime/dist/cli/main.js --version` prints the platform.

## Keep the ledger true

A requirement counts as implemented only when `packages/conformance/ledger.json` maps it to a passing test. Name a test the way Vitest prints it, `<file> > <describe> > <title>`. Edit only the entries for the requirement ids that your change covers.

One test may back at most 8 requirement ids, and a test under `packages/conformance/test/` cannot back a `covered` entry. The ledger check proves that each named test exists and passed, but it cannot prove that the test exercises the requirement. Each PR's spec audit is the control for that.
