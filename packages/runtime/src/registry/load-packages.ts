import type { PackageSignature } from "@standardagents/spec"
import { Effect, FileSystem, Path, Result } from "effect"
import {
  type Definition,
  describeCause,
  type Issue,
  importFile,
  KINDS,
  LoadError,
  type Package,
  PLURAL,
} from "./Registry.ts"

type Source = PackageSignature["source"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is Array<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const entryOf = (manifest: Record<string, unknown>): string => {
  const pick = (target: unknown): string | undefined => {
    if (typeof target === "string") return target
    if (!isRecord(target)) return undefined
    for (const condition of ["import", "default"]) {
      const found = pick(target[condition])
      if (found !== undefined) return found
    }
    return undefined
  }
  const exports = manifest.exports
  const root = isRecord(exports) && "." in exports ? exports["."] : exports
  return pick(root) ?? (typeof manifest.main === "string" ? manifest.main : "index.js")
}

const metaProblem = (meta: unknown, name: string): string | undefined => {
  if (!isRecord(meta)) return "exports no __meta object"
  if (typeof meta.packageId !== "string" || meta.packageId === "") return "has no __meta.packageId"
  if (meta.packageId !== name)
    return `has __meta.packageId ${meta.packageId}, which differs from its package name ${name}`
  if (typeof meta.version !== "string") return "has no __meta.version string"
  if (!isStringArray(meta.entryAgents)) return "has no __meta.entryAgents array of agent names"
  if (typeof meta.packedAt !== "number") return "has no __meta.packedAt timestamp"
  return undefined
}

const withSignature = (definition: unknown, signature: PackageSignature): unknown => {
  if (Array.isArray(definition)) return Object.assign([...definition], { __package: signature })
  if (isRecord(definition)) return { ...definition, __package: signature }
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
      Effect.flatMap((text) => Effect.try({ try: (): unknown => JSON.parse(text), catch: (cause) => cause })),
      Effect.result,
    )
    if (Result.isFailure(read) || !isRecord(read.success)) {
      const reason = Result.isFailure(read) ? describeCause(read.failure) : "It holds JSON that is not an object."
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
        "warning",
      )
    if (!(name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name).startsWith("standardagent-"))
      issue(
        "package_name_prefix",
        relativeManifest,
        `${name} should have a name that starts with standardagent-`,
        "warning",
      )
    if (packages.some((existing) => existing.signature.packageId === name)) {
      issue("package_duplicate", relativeManifest, `${name} is installed more than once`)
      return
    }
    const entry = path.join(dir, entryOf(manifest))
    const file = path.relative(root, entry)
    const loaded = yield* Effect.result(importFile(file, path.toFileUrl(entry)))
    if (Result.isFailure(loaded)) {
      issues.push(...loaded.failure.issues)
      return
    }
    const exports = loaded.success
    const problem = metaProblem(exports.__meta, name)
    if (problem !== undefined || !isRecord(exports.__meta)) {
      issue("package_meta_invalid", file, `${name} ${problem}`)
      return
    }
    const meta = exports.__meta
    const entryAgents = isStringArray(meta.entryAgents) ? meta.entryAgents : []
    const signature: PackageSignature = {
      packageId: name,
      version: String(meta.version),
      source,
      packedAt: Number(meta.packedAt),
    }
    const pkg: Package = { signature, entryAgents, file, manifestFile: relativeManifest, manifest, meta }
    packages.push(pkg)
    for (const kind of KINDS) {
      const loaders = exports[PLURAL[kind]]
      if (loaders === undefined) continue
      if (!isRecord(loaders)) {
        issue("package_invalid", file, `${name} exports ${PLURAL[kind]} that is not an object of loaders`)
        continue
      }
      for (const [key, loader] of Object.entries(loaders)) {
        const at = `${PLURAL[kind]}.${key}`
        const load = Effect.tryPromise({
          try: async () => {
            if (typeof loader !== "function") throw new TypeError(`${at} is not a loader function`)
            return withSignature(await loader(), signature)
          },
          catch: (cause) =>
            new LoadError({
              issues: [
                {
                  code: "definition_load_failed",
                  severity: "error",
                  message: `${name} ${at} failed to load: ${describeCause(cause)}`,
                  file,
                  path: at,
                },
              ],
            }),
        })
        definitions.push({
          kind,
          name: key,
          qualifiedName: `${name}/${key}`,
          package: pkg,
          file,
          path: at,
          load: yield* Effect.cached(load),
        })
      }
    }
    for (const agent of entryAgents) {
      if (!Object.hasOwn(isRecord(exports.agents) ? exports.agents : {}, agent))
        issue("package_entry_agent_undefined", file, `${name} lists entry agent ${agent}, which it does not export`)
    }
  })

  for (const dir of yield* packageDirs(path.join(root, "node_modules"))) yield* loadPackage(dir, "npm")
  for (const dir of yield* packageDirs(path.join(root, "agents", "packed"))) yield* loadPackage(dir, "local")
  return { definitions, packages, issues }
})
