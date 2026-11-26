# Code Quality Review: PR 5 (`m1/2-registry`)

Reviewed PR 5 ("Load and validate agent definitions, `spindle validate`"), base `origin/m1/1-workspace` (`5f0ecf3`), head `origin/m1/2-registry` (`75dab32`). All files under `packages/runtime/src/registry/` and `packages/runtime/src/cli/validate.ts` are byte-for-byte unchanged at the top of the stack, `origin/m1/7-chat` (`43a4d5b`). Every line reference below is at `43a4d5b`.

---

## 1. Verdict

**Does not pass the approval bar.** Behavior and edge-case coverage are thorough, but the implementation carries substantial avoidable structural complexity across its three largest files (`validate.ts` at 632 lines, `load-packages.ts` at 320 lines, and `Registry.ts` at 298 lines). The single largest thing wrong is that `registry/validate.ts` packs 490 lines of purely synchronous checking into one giant `Effect.gen` closure — mixing hand-written shape checks, ten repeated reference-resolution blocks, a duplicate traversal of prompts and models just to rebuild graph edges, and two `try/catch` blocks inside the generator — while `Registry` itself keeps two redundant representations of loaded definitions (`Definition.load` cached Effects alongside an eagerly populated `Registry.loaded` map) that forces every downstream caller in the stack to resolve, look up by reference identity, and cast.

---

## 2. Structural Findings

### S1. `validate.ts` packs 490 lines of synchronous validation, repeated reference checks, and a duplicate graph traversal into one `Effect.gen` closure — and shape validation should be separated declaratively

- **Location:** `packages/runtime/src/registry/validate.ts:137-626`
- **Why it costs maintainers:** `validate` yields `Registry` once on line 138 and then runs 488 lines of purely synchronous code inside the generator, re-allocating 13 closures per call, mutating a closed-over `issues` array, and catching throwing getters with raw `try/catch` inside `Effect.gen` (lines 525 and 584). Shape checks, cross-definition resolution, cycle detection, and package disclosure checks are interleaved in one 632-line file, and lines 512–552 walk every prompt and model a second time solely to extract edges that `checkPrompt` and `checkModel` just resolved.
- **Direct answer on `Schema` (`effect@4.1.5`) vs a small rule table for shape checks:**
  First, an important measurement: **only ~110 lines of `validate.ts`'s 632 lines are pure shape checks** (`checkAgent`'s `side.label` and human-side keys ~10 lines, `checkPrompt` ~40 lines, `checkModel` ~22 lines, `checkTool` ~6 lines, `checkHook` ~9 lines, `checkHandler` ~6 lines, `checkEffect` ~15 lines). The remaining ~520 lines are cross-definition namespace resolution, subagent/tool collision rules, cycle detection, `parentHooks` disclosure comparison, and helpers.

  Checking `effect@4.1.5` (`node_modules/effect/dist/Schema.d.ts`, `SchemaIssue.d.ts`, and live execution against `effect@4.1.5`) shows that `Schema` **can** preserve every existing issue code and field path, with four specific mechanics you must account for:
  1. **Use `Schema.decodeUnknownExit(schema)(value, { errors: "all" })`, not `decodeUnknownResult`.** Both collect all field errors in one pass, and `Schema.Struct` checks `key in input` so it passes both inherited properties (`Object.create(proto)`, tested in `legal-inputs`) and non-enumerable properties (`Object.defineProperties`, tested in `validate.test.ts:678`), while `Schema.Array` catches sparse-array holes that `isStringArray`'s `.every()` currently misses. However, when a property getter throws (`throwing-getter`, `throwing-reads`), `Schema.decodeUnknownResult` replaces the error with `"Result adapter can only return schema issues"`, whereas `Schema.decodeUnknownExit` preserves the exact thrown defect in `Exit.Failure.cause` (`Cause.squash(exit.cause)`).
  2. **Custom issue codes fit `Schema.Annotations`, but missing keys and optional fields need two attachment points.** `Schema.Annotations.Annotations` (`Schema.d.ts:13145-13147`) has an open index signature and supports module augmentation for `{ issueCode: IssueCode; message: string; issuePath?: string }`. Required fields need both `.annotate(...)` (for wrong type/value) and `Schema.annotateKey({ issueCode, messageMissingKey })` (`Schema.d.ts:552`, for `SchemaIssue.MissingKey`). Optional fields using `Schema.optional(S)` create `Union([S, Undefined])`; on a type mismatch like `toolChoice: ["auto"]`, `effect@4.1.5` emits `AnyOf` with `issues: []`, so annotations must live on the outer `Schema.optional(S).annotate(...)` wrapper, not on `S`.
  3. **Four path rules differ from raw AST paths and need explicit stop/override behavior in the issue walker:**
     - `fallbacks: [1, "ok"]` reports one `model_property_invalid` at `"fallbacks"` (not `"fallbacks[0]"`): stop walking at the first node carrying `issueCode`.
     - `effect: [1, [], "nope"]` reports one `effect_invalid` at `""` (not `[0]`/`[1]`/`[2]`): same rule, annotate the root `Schema.Tuple`.
     - `reasoning: 42` reports at `"reasoning.level"` instead of `"reasoning"`: attach `issuePath: "reasoning.level"` on the `reasoning` field.
     - `prompt: [{ type: "bad" }]` must recurse past `prompt`'s union into array element `[0]` and stop at `PromptPart`'s `issueCode` so it reports `"prompt[0]"` (not `"prompt"` or `"prompt[0].type"`).
  4. **`Schema.Finite` vs `Schema.Number` (minor behavior decision):** `validate.ts:406` checks `typeof price === "number" && price >= 0`, which currently accepts `Infinity`. `Schema.Number` matches that (and triggers `effect(schemaNumber)`), while `Schema.Finite` rejects `Infinity`. Rejecting `Infinity` for prices is almost certainly better, but changing it is a behavior tightening that needs the operator's nod.

  **Trade-off comparison:**
  - **Effect `Schema` + 25-line `SchemaIssue` walker** for the 6 non-agent kinds: ~115 lines total (roughly break-even vs the ~110 lines of imperative shape checks today, NOT a dramatic line reduction by itself), but it is declarative, enforces sparse-array checking on string arrays, aligns with Effect's boundary-decoding idiom, and gives typed parsed views if `Registry` adopts them later.
  - **Small declarative field-rule table** (`kind -> Array<FieldRule>` with `required` / `optional` predicates): ~65–75 lines total (~40 lines smaller than `Schema`), zero AST-walker subtleties, trivial 1-to-1 mapping to `(code, path, message)`, but no typed decoded output.
  - **Either choice should be paired with the larger structural simplification** of the other 520 lines of `validate.ts`, which is where most of the line reduction lives.

- **Proposed restructuring:** Split `validate.ts` into two pure, top-level modules with no giant `Effect.gen` closure:
  1. `packages/runtime/src/registry/validate-shapes.ts` (~110 lines with `Schema`, or ~70 lines with a field-rule table): owns pure shape validation per kind (`checkShape(kind, value)` returning `ReadonlyArray<ShapeIssue>` or defect on throwing getter).
     ```ts
     // Sketch using Effect Schema (verified on effect@4.1.5):
     interface RuleMeta {
       readonly issueCode: IssueCode
       readonly message: string
       readonly issuePath?: string
       readonly descend?: boolean // true on PromptContent so array element errors report prompt[i]
     }

     const field = <S extends Schema.Top>(schema: S, code: IssueCode, message: string) =>
       schema.annotate({ issueCode: code, message }).pipe(
         Schema.annotateKey({ issueCode: code, messageMissingKey: message }),
       )

     const optField = <S extends Schema.Top>(schema: S, code: IssueCode, message: string, issuePath?: string) =>
       Schema.optional(schema).annotate({ issueCode: code, message, ...(issuePath ? { issuePath } : {}) })

     // 25-line walker over SchemaIssue.Issue using Pointer.path -> "a.b[0].c":
     // stops at first node whose ast/filter/annotations has issueCode (unless descend && child has issues).
     // Invoked via Schema.decodeUnknownExit(schema)(value, { errors: "all" }) so throwing getters stay defects.

     const NonEmpty = Schema.String.check(Schema.isMinLength(1))
     const Fn = Schema.declare((u): u is (...args: ReadonlyArray<never>) => unknown => typeof u === "function")
     const RecordSchema = Schema.Record(Schema.String, Schema.Unknown)
     const StringList = Schema.Array(Schema.String)

     const HookShape = Schema.Struct({
       hook: field(Schema.Literals(THREAD_HOOKS), "hook_type_invalid", `hook must be one of ${THREAD_HOOKS.join(", ")}`),
       id: field(NonEmpty.check(Schema.isPattern(SNAKE_CASE)), "hook_id_invalid", "id must be a snake_case string"),
       execute: field(Fn, "hook_execute_missing", "execute must be a function"),
     }).annotate({ issueCode: "hook_type_invalid", message: "A hook definition must be an object from defineHook()" })
     // Same pattern for HandlerShape, EffectShape (Schema.Tuple([Schema.String, Schema.NullOr(RecordSchema), Fn])),
     // ToolShape, ModelShape, PromptShape.
     ```
  2. `packages/runtime/src/registry/validate.ts` (~260–290 lines):
     - Replace the 490-line `Effect.gen` with a pure top-level function `validateRegistry(registry: RegistryService): Validation` and a one-line Effect wrapper `export const validate = Effect.map(Registry, validateRegistry)`.
     - Make `Site` a lightweight top-level helper carrying two shared resolution methods that eliminate the 10 repeated `resolve` + `if (_tag !== "Found")` blocks and unify `checkPrompt`'s and `checkTool`'s multi-kind (`tool`/`prompt`/`agent`) lookup:
       - `require(kind, name, code, path, suffix?) -> Definition | undefined`
       - `requireAny(kinds, name, displayKind, code, path) -> { kind, definition } | undefined`
     - Have `checkPrompt` and `checkModel` push resolved edges directly into `includes` and `fallbacks` (excluding self-fallbacks in `checkModel`), deleting `edgesTo` and lines 512–552 completely — and reading `value.prompt` / `value.fallbacks` getters only once instead of twice.
     - Replace the linear `registry.definitions.find(...)` at line 586 with O(1) lookup via `registry.resolve("agent", agentName, { type: "packed", packageId: pkg.signature.packageId })`.
- **Estimated line delta:** `-160` to `-220` lines net (from 632 lines in one file to ~390–450 lines across two clean, cohesive modules; or ~350–390 lines if the rule-table option is chosen over `Schema`).
- **Risk and guarding tests:** Main risks are subtle path/message mismatches (`reasoning.level`, `prompt[0]`, `fallbacks`, `effect_invalid` at `""`), sparse-array handling (`parent-hooks-sparse`), inherited/non-enumerable properties (`legal-inputs`, `validate.test.ts:678`), and throwing getters (`throwing-getter`, `throwing-reads`). All of these are directly guarded by `packages/runtime/test/registry/validate.test.ts` (34 invalid fixture tables + 11 valid fixture cases + throwing-getter/reads tests) and `packages/runtime/test/cli/validate.test.ts`.
- **PR and ripple:** PR 5 (`m1/2-registry`). `validate` keeps its exact exported signature (`Effect.Effect<Validation, never, Registry>`), so PRs 4, 6, 7, 8, and 10 need zero edits on rebase.
- **Effect APIs verified:** Yes — `Schema.decodeUnknownExit` (`node_modules/effect/dist/Schema.d.ts:1285`), `Schema.annotateKey` (`Schema.d.ts:552`), `Schema.Annotations.Annotations` (`Schema.d.ts:13145-13147`), `Schema.Literals` / `Schema.Struct` / `Schema.Tuple` / `Schema.optional` / `Schema.declare` / `Schema.isMinLength` / `Schema.isPattern` / `Schema.isInt` / `Schema.isBetween` (`Schema.d.ts`), `SchemaIssue.Issue` union (`SchemaIssue.d.ts:118-624`), and runtime behavior on inherited properties, non-enumerable properties, sparse arrays, optional `AnyOf`, and throwing getters verified with `node` against installed `effect@4.1.5`.

---

### S2. `Registry` maintains two redundant representations of loaded values (`Definition.load` and `Registry.loaded`), leaking casts and manual lookups across the entire stack

- **Location:** `packages/runtime/src/registry/Registry.ts:91-183`, `packages/runtime/src/registry/load-directory.ts:76-84`, `packages/runtime/src/registry/load-packages.ts:291-299`
- **Why it costs maintainers:** `loadDirectory` and `loadPackages` wrap every definition's loader in `Effect.cached` and attach it as `Definition.load`, yet `Registry.layer` immediately executes every `d.load` eagerly at line 127 (it must, because `identified` reads `.name`/`.id` to build `resolver`) and stores the results in a separate identity-keyed `loaded: ReadonlyMap<Definition, unknown>`. Not a single production file in the entire repository calls `definition.load` after `Registry.layer` runs; instead, every consumer (`validate.ts:185`, `execution/turn.ts:64-69`, `execution/step.ts:506-509`, `execution/thread-state.ts:225`) resolves a `Definition`, looks it up in `registry.loaded`, and casts `as A`.
- **Proposed restructuring:**
  Split internal discovery from the loaded `Registry` contract:
  ```ts
  // Internal to registry/ (load-directory.ts, load-packages.ts -> Registry.ts):
  export interface DiscoveredDefinition {
    readonly kind: Kind
    readonly name: string
    readonly qualifiedName: string
    readonly package: Package | undefined
    readonly file: string
    readonly path: string
    readonly load: Effect.Effect<unknown, LoadError> // no Effect.cached needed; Registry.layer runs it once
  }

  // Public on Registry:
  export interface Definition {
    readonly kind: Kind
    readonly name: string
    readonly qualifiedName: string
    readonly package: Package | undefined
    readonly file: string
    readonly path: string
    readonly value?: unknown // present iff loading succeeded (or use a discriminated `state`)
  }
  ```
  Even cleaner, add `readonly lookup: <A = unknown>(kind: Kind, name: string, from?: NamespaceContext) => { readonly definition: Definition; readonly value: A } | undefined` (or attach `value` on `Found` / `Definition`) directly on `Registry`. That deletes:
  - `Effect.cached` in `load-directory.ts:83` and `load-packages.ts:298`
  - `loaded: ReadonlyMap<Definition, unknown>` from `Registry` (`Registry.ts:114, 128, 149, 176`) and `spindle-driver.ts:40-41`
  - the `lookup` wrapper in `execution/turn.ts:64-69`
  - the `loadedFound` helper in `validate.ts:185-186` and the 4 `yield* x?.load ?? Effect.succeed(undefined)` patterns in `validate.test.ts:454, 460, 482, 532` (which also trigger 4 `effectSucceedWithUndefined` diagnostics)
  - Note: Appendix A (`docs/plans/m1-core-loop.md:662`) mentions `Effect.cached` for lazy loaders, written before Round 2 made `Registry.layer` load every definition eagerly to read `.name`/`.id`. Dropping `Definition.load` changes no runtime or CLI behavior, only the internal `Definition` type.
- **Estimated line delta:** `-45` lines across `registry/`, `execution/turn.ts`, `execution/step.ts`, and tests.
- **Risk and guarding tests:** Low risk; internal API only. Six tests in `packages/runtime/test/registry/validate.test.ts` (lines 454, 460, 482, 497, 532, 736) read `d.load` and would switch to `d.value`; `packages/runtime/test/registry/resolve.test.ts:26` and `packages/runtime/test/spindle-driver.ts:28, 40-41` drop `load` / `loaded`.
- **PR and ripple:** PR 5 (`m1/2-registry`). Ripples cleanly into PR 6 (`execution/turn.ts:64-69`, `test/spindle-driver.ts:21-49`) and PR 8 (`execution/step.ts:506-509`, `test/registry/validate.test.ts:797`).
- **Effect APIs verified:** Yes — `Context.Service`, `Layer.effect`, `Effect.forEach` (`node_modules/effect/dist/Effect.d.ts`).

---

### S3. `load-packages.ts` mixes four responsibilities into a 167-line imperative `loadPackage` function with manual `JSON.parse`, manual `__meta` validation, and redundant coercions

- **Location:** `packages/runtime/src/registry/load-packages.ts:79-86, 136-302`
- **Why it costs maintainers:** `loadPackage` handles manifest JSON parsing, package naming/keyword lints, `exports`/`main` path resolution and `realPath` containment, module importing, `__meta` validation, and per-kind loader wrapping in a single 167-line closure with 12 early returns and mutation of three outer arrays (`definitions`, `packages`, `issues`). Because `metaProblem` returns `string | undefined` instead of decoding a typed value, lines 234–251 immediately repeat `!isRecord(exports.__meta)`, `String(meta.packageId)`, `String(meta.version)`, `Number(meta.packedAt)`, `Array.isArray(meta.entryAgents)`, and `isStringArray(listed)`. Line 190/193 also calls `fs.stat(written)` twice on the common path when `named === written`.
- **Proposed restructuring:**
  1. Decode `package.json` with `Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))` instead of `Effect.try(() => JSON.parse(text))` + `!isRecord(...)` (lines 143–148).
  2. Replace `metaProblem` (lines 79–86) and lines 233–251 with a 6-line `PackedMetaSchema`:
     ```ts
     const PackedMetaSchema = Schema.Struct({
       packageId: Schema.String.check(Schema.isMinLength(1)),
       version: Schema.String,
       entryAgents: Schema.Array(Schema.String),
       packedAt: Schema.Number,
     })
     ```
     Decode via `Schema.decodeUnknownExit(PackedMetaSchema)(exports.__meta)`. Verified against the fixtures: `Schema.Struct` reads only those 4 keys, so `hooks-trap`'s throwing `__meta.parentHooks` getter stays untouched until `validate.ts:592` (`validate.test.ts:365`), while `meta-trap`'s throwing `__meta.version` getter becomes a defect caught by `inspect` (`validate.test.ts:366`).
  3. Split `loadPackage` into three small pure/Effect helpers that return values instead of mutating outer arrays:
     - `readManifest(dir, source)` -> `Option<{ manifest, name, issues }>`
     - `resolvePackageEntry(dir, name, manifest, relativeManifest)` -> `Result<string, Issue>` (caching `writtenKind = yield* typeOf(written)` to remove the duplicate `stat`)
     - `extractPackageDefinitions(pkg, name, exports)` -> `{ definitions, issues }`
- **Estimated line delta:** `-45` to `-60` lines (from 320 to ~265 lines) with `loadPackage` dropping from 167 lines to ~40 lines of linear pipeline.
- **Risk and guarding tests:** Low risk; `metaProblem`'s exact error messages are not asserted by tests (tests assert `package_meta_invalid` + file path in `validate.test.ts:316`). Guarded by `packages/runtime/test/registry/validate.test.ts` (`package-problems`, `package-entries`, `package-entry-outside`, `package-entry-shapes`, `throwing-reads`, `packed-every-kind`, `legal-inputs`, `broken-manifest`) and `packages/runtime/test/cli/validate.test.ts:165-181`.
- **PR and ripple:** PR 5 (`m1/2-registry`). Internal to `load-packages.ts`; zero ripple into later PRs.
- **Effect APIs verified:** Yes — `Schema.fromJsonString` (`Schema.d.ts:7292`), `Schema.decodeEffect` (`Schema.d.ts:1253`), `Schema.decodeUnknownExit` (`Schema.d.ts:1285`), `Schema.Struct`, `Schema.Record`, `Schema.Array`, `Schema.isMinLength`.

---

### S4. Independent filesystem discovery and package inspection work is serialized throughout `Registry.layer`, `loadDirectory`, and `loadPackages`

- **Location:** `packages/runtime/src/registry/Registry.ts:123-124`, `packages/runtime/src/registry/load-directory.ts:36-86`, `packages/runtime/src/registry/load-packages.ts:126-132, 207, 317-318`
- **Why it costs maintainers:** Although `Registry.ts:127` loads definitions with `{ concurrency: 16 }`, every discovery step before it is sequential `for` loops: `loadDirectory` waits for `loadPackages`; `loadDirectory` scans the 7 `KINDS` directories one by one; `loadPackages` scans `node_modules` then `agents/packed`, inspects each package one at a time, and runs `[fs.realPath(dir), fs.realPath(entry), fs.stat(entry)]` sequentially at line 207 because `Effect.all` defaults to sequential execution. Keeping `inspect` sequential was only forced by mutating the shared `packages` array for `package_duplicate` detection (line 240).
- **Proposed restructuring:**
  1. `Registry.ts:123-124`: `const [local, packed] = yield* Effect.all([loadDirectory(root), loadPackages(root)], { concurrency: 2 })`.
  2. `load-directory.ts:36-86`: `Effect.forEach(KINDS, scanKind, { concurrency: "unbounded" })` and flatten the ordered results (input order is preserved by `Effect.forEach`).
  3. `load-packages.ts:207`: `Effect.all([fs.realPath(dir), fs.realPath(entry), fs.stat(entry)], { concurrency: "unbounded" })`.
  4. `load-packages.ts:317-318`: collect the ordered list of `[dir, source]` entries from `node_modules` and `agents/packed` (via `Effect.all(..., { concurrency: 2 })`), inspect them via `Effect.forEach(targets, ([dir, source]) => inspect(dir, source), { concurrency: 16 })` where `inspect` returns `{ pkg?, definitions, issues }` without shared mutation, then fold in order to detect `package_duplicate` deterministically.
- **Estimated line delta:** `-10` to `+5` lines (eliminates mutable accumulator pushing across closures while making concurrency explicit).
- **Risk and guarding tests:** Preserves exact deterministic duplicate precedence (`node_modules` sorted, then `agents/packed` sorted) because `Effect.forEach` preserves input order and duplicate checks run in a deterministic post-pass. Guarded by `packages/runtime/test/registry/validate.test.ts` (all package tests, `duplicate-name`, `package-problems`, `throwing-reads`).
- **PR and ripple:** PR 5 (`m1/2-registry`). Zero ripple into later PRs.
- **Effect APIs verified:** Yes — `Effect.all` and `Effect.forEach` concurrency options (`node_modules/effect/dist/Effect.d.ts`), and confirmed by `@effect/tsgo` `missingConcurrencyOption` on `load-packages.ts:207`.

---

### S5. Composite lookup keys and linear scans over `definitions` are duplicated across `Registry.ts`, `resolve.ts`, and `validate.ts`

- **Location:** `packages/runtime/src/registry/Registry.ts:150, 165`, `packages/runtime/src/registry/resolve.ts:9`, `packages/runtime/src/registry/validate.ts:586`
- **Why it costs maintainers:** `Registry.ts:150` hand-constructs `` `${definition.kind}\u0000${definition.package?.signature.packageId ?? ""}\u0000${definition.name}` ``, duplicating `resolve.ts:9`'s `key(...)`. Immediately after building `byKey`, `Registry.ts:165` does an O(P × E × D) linear scan `definitions.some((d) => d.package === pkg && d.kind === "agent" && d.name === agent)` to check `entryAgents`, and `validate.ts:586` repeats the same linear `registry.definitions.find(...)` when comparing `parentHooks` disclosures.
- **Proposed restructuring:** Export `definitionKey(kind, packageId, name)` from `resolve.ts` (or have `resolver` accept/expose the built index) and use it in `Registry.ts:150`, `Registry.ts:165` (indexing all definitions including failed ones, matching current `definitions.some` semantics for `package_entry_agent_undefined`), and `validate.ts:586` (using `registry.resolve("agent", agentName, { type: "packed", packageId: pkg.signature.packageId })`).
- **Estimated line delta:** `-8` lines.
- **Risk and guarding tests:** Watch one edge case at `Registry.ts:165`: `byKey` currently holds only successfully loaded definitions, while `definitions.some(...)` matches failed definitions too. Checking against an index of all `definitions` (which `resolver(definitions)` already builds on line 179!) preserves exact behavior. Guarded by `validate.test.ts` (`package-problems`, `throwing-reads`, `parent-hooks-sparse`, `parent-hooks-key-order`).
- **PR and ripple:** PR 5 (`m1/2-registry`). Zero ripple into later PRs.
- **Effect APIs verified:** N/A (pure TypeScript).

---

## 3. Effect Practice Findings

Confirmed diagnostics from both the default `@effect/tsgo` run (`/tmp/quality-review/effect-diagnostics-at-tip.txt`) and an expanded `@effect/tsgo` run in a scratch copy with additional rules enabled, grouped by rule.

### E1. `unknownInEffectCatch` (TS377021, default) and `anyUnknownInErrorContext` (TS377030, expanded)

- **Location:** `packages/runtime/src/registry/Registry.ts:279-286`, `packages/runtime/src/registry/load-packages.ts:144`
- **Why it costs maintainers:** `importFile` declares `url: Effect.Effect<URL, unknown>` even though `Path.toFileUrl` has typed error `BadArgument` (`node_modules/effect/dist/Path.d.ts:109`), and its `Effect.tryPromise` uses `catch: (cause) => cause` (`unknown`) only to immediately map it to `LoadError` two lines later. `load-packages.ts:144` similarly uses `Effect.try({ try: (): unknown => JSON.parse(text), catch: (cause) => cause })`, keeping `unknown` in the error channel before unwrapping with `Effect.result`.
- **Proposed restructuring:**
  - In `Registry.ts:279-298`, define a local `toLoadError = (cause: unknown) => new LoadError(...)`, pass it directly to `Effect.tryPromise`'s `catch` and to `Effect.mapError(url, toLoadError)`, and parameterize `url: Effect.Effect<URL, E>` (or take `(file: string, absolute: string)` and yield `Path.Path` inside `importFile`, removing the `Effect` argument altogether).
  - In `load-packages.ts:144`, replace `Effect.try(() => JSON.parse(text))` with `Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))` (also resolves E3 below).
- **Estimated line delta:** `-6` lines.
- **Risk and guarding tests:** None; `LoadError` payload and `fieldIssues` formatting stay identical. Guarded by `validate.test.ts` (`broken-manifest`, `define-agent-helper`, `throwing-reads`).
- **PR and ripple:** PR 5 (`m1/2-registry`). Zero ripple.
- **Effect APIs verified:** Yes — `Path.toFileUrl` (`Path.d.ts:109`), `Schema.decodeEffect` (`Schema.d.ts:1253`), `Schema.fromJsonString` (`Schema.d.ts:7292`).

### E2. `tryCatchInEffectGen` (TS377012, default)

- **Location:** `packages/runtime/src/registry/validate.ts:525, 584`
- **Why it costs maintainers:** Both `try/catch` blocks sit directly inside `validate`'s `Effect.gen` body to catch throwing getters on user definitions and package `__meta`. That mixes imperative exception handling into an Effect generator that doesn't otherwise need to be a generator at all.
- **Proposed restructuring:** Resolved automatically by S1 (making `validateRegistry` a pure function and wrapping it with `Effect.map(Registry, validateRegistry)`). If kept inside Effect, use `Effect.try` / `Effect.catchDefect` instead of `try/catch` inside `Effect.gen`.
- **Estimated line delta:** Included in S1.
- **Risk and guarding tests:** Guarded by `validate.test.ts` (`throwing-getter`, `throwing-reads`).
- **PR and ripple:** PR 5 (`m1/2-registry`). Zero ripple.
- **Effect APIs verified:** Yes — `Effect.map`, `Effect.try`, `Effect.catchDefect` (`Effect.d.ts`).

### E3. `preferSchemaOverJson` (TS377026, expanded) and `globalJsonInEffect` (TS377157, expanded)

- **Location:** `packages/runtime/src/registry/load-packages.ts:144`
- **Why it costs maintainers:** Parsing an untrusted `package.json` with raw `JSON.parse` inside `Effect.try` discards type information and requires a manual `!isRecord(read.success)` check plus manual error formatting on lines 147–148.
- **Proposed restructuring:** Covered by S3 (`Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))`).
  *(Note: `globalJson` also fired on `cli/validate.ts:62, 67` for `JSON.stringify` of plain `Issue` objects in pure formatting functions; those are safe, idiomatic formatting calls and should NOT be rewritten with `Schema`.)*
- **Estimated line delta:** Included in S3.
- **Risk and guarding tests:** Guarded by `validate.test.ts:767` and `test/cli/validate.test.ts:118` (`broken-manifest`).
- **PR and ripple:** PR 5 (`m1/2-registry`). Zero ripple.
- **Effect APIs verified:** Yes — `Schema.fromJsonString` (`Schema.d.ts:7292`).

### E4. `asyncFunction` (TS377081, expanded) inside `Effect.tryPromise`

- **Location:** `packages/runtime/src/registry/load-packages.ts:272-290`
- **Why it costs maintainers:** The packed loader runs two synchronous checks (`typeof loader !== "function"` and `typeof then !== "function"`) inside an `async () =>` callback by throwing synthetic `TypeError`s only to catch them immediately in the enclosing `Effect.tryPromise`'s `catch` callback, mixing synchronous validation with promise settlement.
- **Proposed restructuring:** Run the synchronous guards (`typeof loader !== "function"`, invoking `loader()`, checking `typeof then !== "function"`) in `Effect.try` / `Effect.fail(toLoadError(...))` and pass only `Promise.resolve(pending)` to `Effect.tryPromise`, mapping the resolved value through `withSignature`.
- **Estimated line delta:** `~0` lines, cleaner separation of sync vs async failure.
- **Risk and guarding tests:** Note that `pending` may be a thenable from another realm (`legal-inputs` fixture) and `loader()` itself can throw synchronously (`packed-define-agent` fixture). Wrapping `loader()` in `Effect.try` and awaiting `Promise.resolve(pending)` preserves both. Guarded by `validate.test.ts` (`package-problems` `sync_prompt`, `packed-define-agent`, `legal-inputs`, `packed-every-kind`).
- **PR and ripple:** PR 5 (`m1/2-registry`). Zero ripple.
- **Effect APIs verified:** Yes — `Effect.try`, `Effect.tryPromise`, `Effect.flatMap` (`Effect.d.ts`).

### E5. `missingConcurrencyOption` (TS377188, expanded)

- **Location:** `packages/runtime/src/registry/load-packages.ts:207` (and `packages/runtime/test/registry/validate.test.ts:735`)
- **Why it costs maintainers:** `Effect.all([fs.realPath(dir), fs.realPath(entry), fs.stat(entry)])` omits `concurrency`, so three independent filesystem queries run sequentially while reading like a parallel batch.
- **Proposed restructuring:** Pass `{ concurrency: "unbounded" }` on `load-packages.ts:207` (included in S4) and `validate.test.ts:735`.
- **Estimated line delta:** `0` lines.
- **Risk and guarding tests:** None. Guarded by `validate.test.ts` (`package-entry-outside`, `package-entries`, `package-entry-shapes`).
- **PR and ripple:** PR 5 (`m1/2-registry`). Zero ripple.
- **Effect APIs verified:** Yes — `Effect.all` (`Effect.d.ts`).

### E6. `preferTypedSchemaDecoder` (TS377112, default) and `yieldInCallArgument` (TS377171, expanded)

- **Location:** `packages/runtime/src/cli/main.ts:18`
- **Why it costs maintainers:** `fs.readFileString(file)` already returns `string`, which is `PackageJson`'s `Encoded` type (`Schema.fromJsonString(...)`), so `Schema.decodeUnknownEffect` discards compile-time input checking; nesting `yield* fs.readFileString(file)` inside the call argument also blends effect execution into argument evaluation.
- **Proposed restructuring:**
  ```ts
  const text = yield* fs.readFileString(file)
  const { version } = yield* Schema.decodeEffect(PackageJson)(text)
  ```
- **Estimated line delta:** `+1` line.
- **Risk and guarding tests:** None. Guarded by `spindle --version` CLI tests.
- **PR and ripple:** Introduced in PR 2 (`m1/1-workspace`), touched in PR 5 (`m1/2-registry`). PR 2 should carry it; trivial 2-line change with no rebase conflict in PR 5–10.
- **Effect APIs verified:** Yes — `Schema.decodeEffect` (`Schema.d.ts:1253`).

### E7. `effectSucceedWithUndefined` (TS377162, default) and `unnecessaryEffectGen` (TS377017, default) in registry tests

- **Location:** `packages/runtime/test/registry/validate.test.ts:454, 460, 482, 532` and `packages/runtime/test/registry/validate.test.ts:791`
- **Why it costs maintainers:** Four tests write `Effect.succeed(undefined)` instead of `Effect.undefined` (solely as a fallback for `Definition.load`), and line 791 wraps `return yield* Registry` in a redundant single-statement `Effect.gen` instead of `Effect.provide(Registry, Registry.layer(root))`.
- **Proposed restructuring:** Lines 454, 460, 482, 532 disappear under S2 (or become `Effect.undefined`). Line 791 simplifies to `const registry = yield* Effect.provide(Registry, Registry.layer(root))`.
- **Estimated line delta:** `-3` lines.
- **Risk and guarding tests:** Test-only; zero behavior risk.
- **PR and ripple:** Lines 454–532 belong in PR 5 (`m1/2-registry`); lines 786–804 were added later in PR 8 (`m1/6-queue`, commit `dde3393`), so PR 8 carries the line 791 cleanup.
- **Effect APIs verified:** Yes — `Effect.undefined` (`Effect.d.ts:1738`), `Effect.provide` (`Effect.d.ts`).

### E8. Hand-rolled `isRecord` duplicates Effect's built-in `Predicate.isObject`

- **Location:** `packages/runtime/src/registry/validate.ts:64`, `packages/runtime/src/registry/load-packages.ts:18`
- **Why it costs maintainers:** Both registry files define their own `isRecord` guard (and 11 other files in `packages/runtime/src/` copy-paste the exact same 2-line function). In `effect@4.1.5`, `Predicate.isObject` (`Predicate.d.ts:1170`, `input is { [x: PropertyKey]: unknown }`) and `Predicate.isReadonlyObject` (`Predicate.d.ts:1195`) already implement `typeof x === "object" && x !== null && !Array.isArray(x)` (note: `Predicate.isRecord` was v3 and does not exist in v4.1.5).
- **Proposed restructuring:** Replace local `isRecord` with `Predicate.isObject` (where `Schema` does not already eliminate the guard).
- **Estimated line delta:** `-4` lines in PR 5 (and `-22` lines across the rest of the stack).
- **Risk and guarding tests:** Verified with `node` on `effect@4.1.5`: `Predicate.isObject` returns `true` for `{}`, `false` for `[]`, `null`, and `() => {}` — identical runtime semantics to `isRecord`.
- **PR and ripple:** PR 5 (`m1/2-registry`) for the two registry files; later PRs can adopt `Predicate.isObject` independently.
- **Effect APIs verified:** Yes — `Predicate.isObject` (`node_modules/effect/dist/Predicate.d.ts:1170`) and `Predicate.isReadonlyObject` (`Predicate.d.ts:1195`), runtime-tested in `node`.

*(Rules checked and intentionally NOT flagged: `preferSchemaTaggedError` on `LoadError` and `IssuesFound` — these are internal in-process errors never serialized over a wire boundary, so `Data.TaggedError` is idiomatic; `strictEffectProvide` on `cli/validate.ts:86` and `cli/main.ts:29` — CLI command handlers are the application entry boundary for dynamic `--dir` arguments; `globalJson` on `cli/validate.ts:62, 67` — plain CLI output formatting.)*

---

## 4. Duplication With Code From Other Pull Requests

- **`isRecord` copied 13 times across `packages/runtime/src/`:** `registry/validate.ts:64` and `registry/load-packages.ts:18` (PR 5), `store/schema.ts:182` (PR 4), `providers/config.ts:14`, `providers/openai-compatible.ts:29`, `execution/assemble.ts:19`, `execution/call.ts:27`, `execution/messages.ts:47`, `execution/tools.ts:27`, `execution/turn.ts:53`, `execution/thread-state.ts:86` (PR 6), `execution/hooks.ts:59` (PR 7), and `execution/ThreadSupervisor.ts:65` (PR 8). All match `Predicate.isObject` from `effect`.
- **Validation error printing duplicated across three CLI commands:** `cli/validate.ts:11, 15, 52` (PR 5) formats issue lines with `location(issue)` and `oneLine(...)` escaping. `cli/run.ts:187-192` (PR 6) and `cli/chat.ts:350-357` (PR 10) each re-implement error filtering, `file:path` formatting, and pluralized error counts — and both omit `oneLine(...)` escaping, so a multiline loader error prints raw newlines in `run`/`chat` while `validate` escapes them. Exporting a small `formatIssueLine(issue)` (or `reportValidationErrors(root, issues)`) from `cli/validate.ts` eliminates all three copies and fixes the inconsistency.
- **`backingOf` duplicated:** `registry/validate.ts:74-77` (PR 5) and `execution/turn.ts:71-77` (PR 6) both determine `"human" | "prompt" | "handler"` backing from an agent side object.
- **`THREAD_HOOKS` list duplicated:** `registry/validate.ts:15-30` (PR 5) hardcodes the 14 thread hook names; `execution/hooks.ts:26-40` (PR 7) defines the 13 implemented hook positions (all except `after_subagent_created`, which waits for M3). Exporting `THREAD_HOOKS` as a canonical constant (or deriving from one shared list) prevents drift when M3 adds `after_subagent_created`.
- **`describeCause` / `describe` error-to-string helpers duplicated 5 times:** `registry/Registry.ts:213` (PR 5), `execution/tools.ts:31`, `execution/step.ts:238`, `cli/run.ts:111` (PR 6), and `cli/chat.ts:43` (PR 10). Only `Registry.ts:213`'s `describeCause` safely guards against a thrown value whose `.message` getter or `String(cause)` itself throws (`opaque_throw.ts`).
- **`plural` helper duplicated:** `cli/validate.ts:17` (PR 5) and `cli/run.ts:144` (PR 6) define the exact same `const plural = (count: number, word: string) => ...`.

---

## 5. What Is Good and Should Not Be Touched

- **`packages/runtime/src/registry/resolve.ts` (28 lines):** Tight, pure, zero-bloat implementation of the namespace visibility table delegating cleanly to `parseQualifiedName` and `isVisibleInNamespace` from `@standardagents/spec`. Keep as-is (only export `key` for `Registry.ts`).
- **`Registry` layer error channel is `never` with one-pass issue accumulation:** Every read, parse, import, and getter failure becomes an `Issue` so `spindle validate` reports all problems in one pass. That design is clean and well-tested; preserve it in any refactor.
- **`withSignature` (`load-packages.ts:88-96`):** Uses `Object.create(Object.getPrototypeOf(definition), { ...Object.getOwnPropertyDescriptors(definition), __package: ... })` so packed definitions keep both prototype inheritance and non-enumerable properties. Do not simplify this to `{ ...definition, __package }`, which breaks `legal-inputs` and `validate.test.ts:678`.
- **Package entry resolution (`entryOf` / `exportTarget`) and `realPath` containment check (`load-packages.ts:35-76, 207-226`):** Concise, handles Node/Bun parity (`.js` extensionless `main`, directory `index.js`, conditional `exports`, fallback arrays, `null` disabling), and refuses to import anything resolving outside the package directory.
- **`describeImportFailure` and `fieldIssues` (`Registry.ts:208-277`):** Clear, defensive handling of `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, throwing `cause` objects, and multi-line `defineAgent` errors.
- **`packages/runtime/src/cli/validate.ts` (92 lines):** Clean, readable CLI module with `IssuesFound` setting `[Runtime.errorReported] = false` so `runMain` exits 1 without printing a stack trace, and `oneLine` escaping line separators in text mode while preserving raw text in `--json`.
- **Table-driven fixture suite (`packages/runtime/test/registry/validate.test.ts:34-395`):** Compact and high-signal; every invalid case asserts exact `(code, file:path, severity)` tuples, making refactoring `validate.ts` safe to verify.

---

## 6. What I Could Not Judge

- **Live runtime and Bun performance behavior:** I did not run the 200-definition `generate-large.mjs` benchmark or execute the Bun test suite (only Node `effect@4.1.5` probes and `@effect/tsgo` typechecking were run in the scratch copy). While S4 parallelizes discovery I/O, I did not measure its wall-time effect on Node vs Bun.
- **Whether `Schema.Finite` should replace `typeof price === "number" && price >= 0` for model prices (`validate.ts:406`):** Rejecting `Infinity` is a minor behavior change not covered by existing tests or Appendix A, so it requires an operator decision if `validate.ts` adopts `Schema`.
- **Whether any future M2/M3 consumer intends truly lazy loading via `Definition.load`:** At `origin/m1/7-chat`, `Registry.layer` already loads every definition eagerly (and must, to read `.name`/`.id` per `DIVERGENCES.md:49`), so `Definition.load` is dead weight today. If a future milestone plans to skip loading definitions until first use without reading `.name`/`.id` up front, that requirement is not reflected in the current design.
