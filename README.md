# Spindle

Spindle is a self-hosted runtime for [Standard Agent Specification](https://standardagentspec.org/) 0.2.0, written in TypeScript on Effect v4. It runs on Node and on Bun.

Spindle is in its first milestone. Today the `spindle` command prints only its version and its help. The plan for milestone 1 is in [docs/plans/m1-core-loop.md](docs/plans/m1-core-loop.md).

## Requirements

- Node 22.19.0 or later, or Bun 1.4.5 or later.
- pnpm 10.

## Build and check

```sh
pnpm install
pnpm check
pnpm build
node packages/runtime/dist/cli/main.js --version
```

`pnpm check` runs Biome, `tsc`, Vitest, the requirement check, and the ledger check. To run the same steps under Bun, run `bun --bun run check`.

## Track conformance

`packages/conformance/requirements.json` holds every normative statement in the spec, extracted from the commit that `packages/conformance/spec.lock.json` pins. `packages/conformance/ledger.json` maps each statement to a status and to the tests that cover it. A statement counts as implemented only when the ledger names a passing test for it.

To check `requirements.json` against the pinned spec, run `node scripts/spec-requirements.mjs --refresh --check`. To rewrite it after you change the pinned commit, run `node scripts/spec-requirements.mjs --refresh`, then run `node scripts/seed-ledger.mjs` to add ledger entries for the new ids.

## License

MIT. See [LICENSE](LICENSE).
