import type { PackageSignature } from "@standardagents/spec"
import { Effect, FileSystem, Path, Result } from "effect"
import {
  type Definition,
  describeCause,
  fieldIssues,
  type Issue,
  importFile,
  KINDS,
  LoadError,
  type Package,
  PLURAL,
  reportDefects,
} from "./Registry.ts"

type Source = PackageSignature["source"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

// Node and Bun both match these conditions, so a package resolves to the same entry on either runtime.
const CONDITIONS = ["import", "node", "default"]

type Entry =
  | { readonly _tag: "Main"; readonly target: string }
  | { readonly _tag: "Export"; readonly target: string }
  | { readonly _tag: "Invalid"; readonly problem: string }

const invalid = (problem: string): Entry => ({ _tag: "Invalid", problem })

// A matched condition whose value is null disables the entry, as it does for Node and Bun, so the search stops there.
const exportTarget = (value: unknown): Entry | undefined => {
  if (value === null) return invalid("disables its root export with null")
  // An array lists fallbacks, and Node and Bun both take the first target they can use.
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = exportTarget(item)
      if (found !== undefined && found._tag !== "Invalid") return found
    }
    return invalid("has an exports array with no usable target")
  }
  if (typeof value === "string")
    return value.startsWith("./")
      ? { _tag: "Export", target: value }
      : invalid(`exports the root target ${value}, which does not start with ./`)
  if (!isRecord(value) || Object.keys(value).some((key) => key.startsWith(".")))
    return invalid("has a root export that is not a path, null, or an object of conditions")
  for (const [condition, target] of Object.entries(value)) {
    if (!CONDITIONS.includes(condition)) continue
    const found = exportTarget(target)
    if (found !== undefined) return found
  }
  return undefined
}

const entryOf = (manifest: Record<string, unknown>): Entry => {
  const { exports, main } = manifest
  if (exports === undefined) {
    if (main === undefined) return { _tag: "Main", target: "index.js" }
    return typeof main === "string" && main !== ""
      ? { _tag: "Main", target: main }
      : invalid("has a main that is not a path")
  }
  const keys = isRecord(exports) ? Object.keys(exports) : []
  const subpaths = keys.filter((key) => key.startsWith("."))
  if (subpaths.length > 0 && subpaths.length < keys.length)
    return invalid("mixes subpath keys and condition keys in exports")
  if (subpaths.length > 0 && !subpaths.includes(".")) return invalid("has exports with no root entry")
  return (
    exportTarget(subpaths.length > 0 ? Reflect.get(exports as object, ".") : exports) ??
    invalid(`exports no root entry under the conditions ${CONDITIONS.join(", ")}`)
  )
}

// PackedMeta.packageId is the npm name or a local identifier, so it may differ from the package.json name.
const metaProblem = (meta: unknown): string | undefined => {
  if (!isRecord(meta)) return "exports no __meta object"
  if (typeof meta.packageId !== "string" || meta.packageId === "") return "has no __meta.packageId"
  if (typeof meta.version !== "string") return "has no __meta.version string"
  if (!isStringArray(meta.entryAgents)) return "has no __meta.entryAgents array of agent names"
  if (typeof meta.packedAt !== "number") return "has no __meta.packedAt timestamp"
  return undefined
}

const withSignature = (definition: unknown, signature: PackageSignature): unknown => {
  if (Array.isArray(definition)) return Object.assign([...definition], { __package: signature })
  if (isRecord(definition))
    return Object.create(Object.getPrototypeOf(definition), {
      ...Object.getOwnPropertyDescriptors(definition),
      __package: { value: signature, writable: true, enumerable: true, configurable: true },
    })
  return definition
}

export const loadPackages = Effect.fn("loadPackages")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const definitions: Array<Definition> = []
  const packages: Array<Package> = []
  const issues: Array<Issue> = []
  const issue = (code: Issue["code"], file: string, message: string, severity: Issue["severity"] = "error") =>
    issues.push({ code, severity, message, file, path: "" })

  // A failed check counts as present, so the read that follows reports the cause as an issue.
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => true))

  const entriesOf = (dir: string) =>
    fs.readDirectory(dir).pipe(
      Effect.map((entries) => entries.sort()),
      Effect.catch((error) => {
        issue(
          "package_invalid",
          path.relative(root, dir),
          `Spindle cannot read ${path.relative(root, dir)} as a directory. ${error.message}`,
        )
        return Effect.succeed([])
      }),
    )

  const packageDirs = Effect.fn(function* (dir: string) {
    if (!(yield* exists(dir))) return []
    const found: Array<string> = []
    for (const entry of yield* entriesOf(dir)) {
      if (entry.startsWith(".")) continue
      const full = path.join(dir, entry)
      if (entry.startsWith("@")) {
        for (const scoped of yield* entriesOf(full)) found.push(path.join(full, scoped))
      } else found.push(full)
    }
    return found
  })

  const loadPackage = Effect.fn(function* (dir: string, source: Source) {
    const manifestFile = path.join(dir, "package.json")
    const relativeManifest = path.relative(root, manifestFile)
    if (!(yield* exists(manifestFile))) {
      if (source === "local") issue("package_invalid", relativeManifest, `${relativeManifest} does not exist`)
      return
    }
    const read = yield* fs.readFileString(manifestFile).pipe(
      Effect.mapError(describeCause),
      Effect.flatMap((text) => Effect.try({ try: (): unknown => JSON.parse(text), catch: describeCause })),
      Effect.result,
    )
    if (Result.isFailure(read) || !isRecord(read.success)) {
      const reason = Result.isFailure(read) ? read.failure : "It holds JSON that is not an object."
      issue(
        "package_invalid",
        relativeManifest,
        `${relativeManifest} is not a JSON object. ${reason}`,
        source === "local" ? "error" : "warning",
      )
      return
    }
    const manifest = read.success
    if (manifest.standardagent === undefined) {
      if (source === "local")
        issue("package_invalid", relativeManifest, `${relativeManifest} has no standardagent field`)
      return
    }
    const name = typeof manifest.name === "string" ? manifest.name : path.relative(root, dir)
    if (!isStringArray(manifest.keywords) || !manifest.keywords.includes("standardagent"))
      issue(
        "package_keyword_missing",
        relativeManifest,
        `${name} must list "standardagent" in its package.json keywords`,
      )
    if (!(name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name).startsWith("standardagent-"))
      issue(
        "package_name_prefix",
        relativeManifest,
        `${name} should have a name that starts with standardagent-`,
        "warning",
      )
    const target = entryOf(manifest)
    if (target._tag === "Invalid") {
      issue("package_invalid", relativeManifest, `${name} ${target.problem}`)
      return
    }
    const typeOf = (file: string) =>
      fs.stat(file).pipe(
        Effect.map((info) => info.type),
        Effect.orElseSucceed(() => "Missing" as const),
      )
    const written = path.resolve(dir, target.target)
    // Node and Bun both try a main without its extension as a .js file.
    const named =
      target._tag === "Main" && (yield* typeOf(written)) === "Missing" && (yield* typeOf(`${written}.js`)) === "File"
        ? `${written}.js`
        : written
    const kind = yield* typeOf(named)
    // Node does not import a directory and Bun does, so Spindle picks the index.js of a main directory itself.
    const entry = kind === "Directory" && target._tag === "Main" ? path.join(named, "index.js") : named
    const unusable =
      kind === "Missing"
        ? "which does not exist"
        : kind === "Directory" && target._tag === "Export"
          ? "which is a directory. An export target must name a file."
          : undefined
    if (unusable !== undefined) {
      issue("package_invalid", relativeManifest, `${name} names the entry ${target.target}, ${unusable}`)
      return
    }
    const file = path.relative(root, entry)
    const located = yield* Effect.all([fs.realPath(dir), fs.realPath(entry), fs.stat(entry)], { concurrency: 1 }).pipe(
      Effect.result,
    )
    if (Result.isFailure(located) || located.success[2].type !== "File") {
      issue(
        "package_invalid",
        relativeManifest,
        kind === "Directory"
          ? `${name} names the main directory ${target.target}, which holds no index.js file`
          : `${name} names the entry ${target.target}, which is not a file`,
      )
      return
    }
    const [home, resolved] = located.success
    if (!resolved.startsWith(home + path.sep)) {
      issue(
        "package_invalid",
        relativeManifest,
        `${name} names the entry ${target.target}, which resolves to ${resolved}, outside the package directory ${home}. Spindle imports only files inside a package.`,
      )
      return
    }
    const loaded = yield* Effect.result(importFile(file, path.toFileUrl(entry)))
    if (Result.isFailure(loaded)) {
      issues.push(...loaded.failure.issues)
      return
    }
    const exports = loaded.success
    const problem = metaProblem(exports.__meta)
    if (problem !== undefined || !isRecord(exports.__meta)) {
      issue("package_meta_invalid", file, `${name} ${problem}`)
      return
    }
    const meta = exports.__meta
    const packageId = String(meta.packageId)
    if (packages.some((existing) => existing.signature.packageId === packageId)) {
      issue("package_duplicate", relativeManifest, `${packageId} is installed more than once`)
      return
    }
    const listed: unknown = Array.isArray(meta.entryAgents) ? [...meta.entryAgents] : undefined
    const entryAgents = isStringArray(listed) ? listed : []
    const signature: PackageSignature = {
      packageId,
      version: String(meta.version),
      source,
      packedAt: Number(meta.packedAt),
    }
    const pkg: Package = { signature, entryAgents, file, manifestFile: relativeManifest, manifest, meta }
    packages.push(pkg)
    for (const kind of KINDS) {
      const loaders = exports[PLURAL[kind]]
      if (loaders === undefined && kind === "effect") continue
      if (!isRecord(loaders)) {
        issues.push({
          code: "package_invalid",
          severity: "error",
          message:
            loaders === undefined
              ? `${name} does not export ${PLURAL[kind]}. A package exports every registry except effects and threadEndpoints, even when it is empty.`
              : `${name} exports ${PLURAL[kind]} that is not an object of loaders`,
          file,
          path: PLURAL[kind],
        })
        continue
      }
      for (const [key, loader] of Object.entries(loaders)) {
        const at = `${PLURAL[kind]}.${key}`
        const load = Effect.tryPromise({
          try: async () => {
            if (typeof loader !== "function") throw new TypeError(`${at} is not a loader function`)
            const pending: unknown = loader()
            // A Promise from another realm fails instanceof Promise, so any thenable counts.
            const then = typeof pending === "object" && pending !== null ? Reflect.get(pending, "then") : undefined
            if (typeof then !== "function") throw new TypeError(`${at} returns a value, not a Promise`)
            return withSignature(await pending, signature)
          },
          catch: (cause) =>
            new LoadError({
              issues: fieldIssues(
                cause,
                { file, path: at },
                (message) => `${name} ${at} failed to load: ${message}`,
                `${name} ${at} failed to load: ${describeCause(cause)}`,
              ),
            }),
        })
        definitions.push({
          kind,
          name: key,
          qualifiedName: `${packageId}/${key}`,
          package: pkg,
          file,
          path: at,
          load: yield* Effect.cached(reportDefects(load, { kind, file, path: at })),
        })
      }
    }
  })

  const inspect = (dir: string, source: Source) =>
    loadPackage(dir, source).pipe(
      Effect.catchDefect((cause) =>
        Effect.sync(() =>
          issue(
            "package_invalid",
            path.relative(root, path.join(dir, "package.json")),
            `The package in ${path.relative(root, dir)} threw while Spindle read it. ${describeCause(cause)}`,
          ),
        ),
      ),
    )

  for (const dir of yield* packageDirs(path.join(root, "node_modules"))) yield* inspect(dir, "npm")
  for (const dir of yield* packageDirs(path.join(root, "agents", "packed"))) yield* inspect(dir, "local")
  return { definitions, packages, issues }
})
