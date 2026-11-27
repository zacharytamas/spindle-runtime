import type { PackageSignature } from "@standardagents/spec"
import { Effect, FileSystem, Path, Predicate, Result } from "effect"
import { type Issue, issue, KINDS, type Package, pluralKind } from "./definition.ts"
import { type Discovered, describeCause, type ImportFile, loadFailure } from "./load-error.ts"
import { packageEntry } from "./package-entry.ts"

type Source = PackageSignature["source"]

const isStringArray = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

// PackedMeta.packageId is the npm name or a local identifier, so it may differ from the package.json name.
const metaProblem = (meta: unknown): string | undefined => {
  if (!Predicate.isObject(meta)) return "exports no __meta object"
  if (typeof meta.packageId !== "string" || meta.packageId === "") return "has no __meta.packageId"
  if (typeof meta.version !== "string") return "has no __meta.version string"
  if (!isStringArray(meta.entryAgents)) return "has no __meta.entryAgents array of agent names"
  if (typeof meta.packedAt !== "number") return "has no __meta.packedAt timestamp"
  return undefined
}

const withSignature = (definition: unknown, signature: PackageSignature): unknown => {
  if (Array.isArray(definition)) return Object.assign([...definition], { __package: signature })
  if (Predicate.isObject(definition))
    return Object.create(Object.getPrototypeOf(definition), {
      ...Object.getOwnPropertyDescriptors(definition),
      __package: { value: signature, writable: true, enumerable: true, configurable: true },
    })
  return definition
}

const collectDefinitions = (
  pkg: Package,
  name: string,
  exports: Record<string, unknown>,
  definitions: Array<Discovered>,
  issues: Array<Issue>,
) => {
  const { file, signature } = pkg
  for (const kind of KINDS) {
    const plural = pluralKind(kind)
    const loaders = exports[plural]
    if (loaders === undefined && kind === "effect") continue
    if (!Predicate.isObject(loaders)) {
      issues.push({
        code: "package_invalid",
        severity: "error",
        message:
          loaders === undefined
            ? `${name} does not export ${plural}. A package exports every registry except effects and threadEndpoints, even when it is empty.`
            : `${name} exports ${plural} that is not an object of loaders`,
        file,
        path: plural,
      })
      continue
    }
    for (const [key, loader] of Object.entries(loaders)) {
      const at = `${plural}.${key}`
      const load = Effect.tryPromise({
        try: async () => {
          if (typeof loader !== "function") throw new TypeError(`${at} is not a loader function`)
          const pending: unknown = loader()
          // A Promise from another realm fails instanceof Promise, so any thenable counts.
          const then = typeof pending === "object" && pending !== null ? Reflect.get(pending, "then") : undefined
          if (typeof then !== "function") throw new TypeError(`${at} returns a value, not a Promise`)
          return withSignature(await pending, signature)
        },
        catch: (cause) => {
          const prefix = `${name} ${at} failed to load: `
          return loadFailure(cause, file, at, prefix, prefix + describeCause(cause))
        },
      })
      definitions.push({
        kind,
        name: key,
        qualifiedName: `${signature.packageId}/${key}`,
        package: pkg,
        file,
        path: at,
        load,
      })
    }
  }
}

export const packageDirs = Effect.fn(function* (root: string, source: Source) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dir = source === "npm" ? path.join(root, "node_modules") : path.join(root, "agents", "packed")
  const issues: Array<Issue> = []
  const directories: Array<string> = []
  const entriesOf = (directory: string) =>
    fs.readDirectory(directory).pipe(
      Effect.map((entries) => entries.sort()),
      Effect.catch((error) => {
        const file = path.relative(root, directory)
        issues.push(issue("package_invalid", file, "", `Spindle cannot read ${file} as a directory. ${error.message}`))
        return Effect.succeed([])
      }),
    )
  if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => true))) {
    for (const entry of yield* entriesOf(dir)) {
      if (entry.startsWith(".")) continue
      const full = path.join(dir, entry)
      if (entry.startsWith("@")) {
        for (const child of yield* entriesOf(full)) directories.push(path.join(full, child))
      } else directories.push(full)
    }
  }
  return { directories, issues }
})

export const loadPackages = Effect.fn("loadPackages")(function* (
  root: string,
  importFile: ImportFile,
  npm: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const definitions: Array<Discovered> = []
  const packages: Array<Package> = []
  const issues: Array<Issue> = []
  const report = (code: Issue["code"], file: string, message: string, severity: Issue["severity"] = "error") =>
    issues.push({ code, severity, message, file, path: "" })

  // A failed check counts as present, so the read that follows reports the cause as an issue.
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => true))

  const readManifest = Effect.fn(function* (dir: string, source: Source) {
    const manifestFile = path.join(dir, "package.json")
    const relativeManifest = path.relative(root, manifestFile)
    if (!(yield* exists(manifestFile))) {
      if (source === "local") report("package_invalid", relativeManifest, `${relativeManifest} does not exist`)
      return
    }
    const read = yield* fs.readFileString(manifestFile).pipe(
      Effect.mapError(describeCause),
      Effect.flatMap((text) => Effect.try({ try: (): unknown => JSON.parse(text), catch: describeCause })),
      Effect.result,
    )
    if (Result.isFailure(read) || !Predicate.isObject(read.success)) {
      const reason = Result.isFailure(read) ? read.failure : "It holds JSON that is not an object."
      report(
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
        report("package_invalid", relativeManifest, `${relativeManifest} has no standardagent field`)
      return
    }
    const name = typeof manifest.name === "string" ? manifest.name : path.relative(root, dir)
    if (!isStringArray(manifest.keywords) || !manifest.keywords.includes("standardagent"))
      report(
        "package_keyword_missing",
        relativeManifest,
        `${name} must list "standardagent" in its package.json keywords`,
      )
    if (!(name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name).startsWith("standardagent-"))
      report(
        "package_name_prefix",
        relativeManifest,
        `${name} should have a name that starts with standardagent-`,
        "warning",
      )
    return { manifest, name, relativeManifest }
  })

  const loadPackage = Effect.fn(function* (dir: string, source: Source) {
    const info = yield* readManifest(dir, source)
    if (!info) return
    const { manifest, name, relativeManifest } = info
    const located = yield* Effect.result(packageEntry(dir, manifest))
    if (Result.isFailure(located)) {
      report("package_invalid", relativeManifest, `${name} ${located.failure}`)
      return
    }
    const entry = located.success
    const file = path.relative(root, entry)
    const loaded = yield* Effect.result(importFile(file, path.toFileUrl(entry)))
    if (Result.isFailure(loaded)) {
      issues.push(...loaded.failure.issues)
      return
    }
    const exports = loaded.success
    const problem = metaProblem(exports.__meta)
    if (problem !== undefined || !Predicate.isObject(exports.__meta)) {
      report("package_meta_invalid", file, `${name} ${problem}`)
      return
    }
    const meta = exports.__meta
    const packageId = String(meta.packageId)
    if (packages.some((existing) => existing.signature.packageId === packageId)) {
      report("package_duplicate", relativeManifest, `${packageId} is installed more than once`)
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
    collectDefinitions(pkg, name, exports, definitions, issues)
  })

  const inspect = (dir: string, source: Source) =>
    loadPackage(dir, source).pipe(
      Effect.catchDefect((cause) =>
        Effect.sync(() =>
          report(
            "package_invalid",
            path.relative(root, path.join(dir, "package.json")),
            `The package in ${path.relative(root, dir)} threw while Spindle read it. ${describeCause(cause)}`,
          ),
        ),
      ),
    )

  for (const dir of npm) yield* inspect(dir, "npm")
  const local = yield* packageDirs(root, "local")
  issues.push(...local.issues)
  for (const dir of local.directories) yield* inspect(dir, "local")
  return { definitions, packages, issues }
})
