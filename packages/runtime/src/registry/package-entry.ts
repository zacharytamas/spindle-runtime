import { Effect, FileSystem, Path, Result } from "effect"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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

export const packageEntry = Effect.fn(function* (dir: string, manifest: Record<string, unknown>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const target = entryOf(manifest)
  if (target._tag === "Invalid") {
    return yield* Effect.fail(target.problem)
  }
  const typeOf = (file: string) =>
    fs.stat(file).pipe(
      Effect.map((info) => info.type),
      Effect.orElseSucceed(() => "Missing" as const),
    )
  let named = path.resolve(dir, target.target)
  let kind = yield* typeOf(named)
  // Both runtimes try a .js suffix on an extensionless main.
  if (target._tag === "Main" && kind === "Missing" && (yield* typeOf(`${named}.js`)) === "File") {
    named += ".js"
    kind = "File"
  }
  // Node does not import a directory and Bun does, so Spindle picks the index.js of a main directory itself.
  const entry = kind === "Directory" && target._tag === "Main" ? path.join(named, "index.js") : named
  const unusable =
    kind === "Missing"
      ? "which does not exist"
      : kind === "Directory" && target._tag === "Export"
        ? "which is a directory. An export target must name a file."
        : undefined
  if (unusable !== undefined) {
    return yield* Effect.fail(`names the entry ${target.target}, ${unusable}`)
  }
  const located = yield* Effect.all([fs.realPath(dir), fs.realPath(entry), fs.stat(entry)], { concurrency: 3 }).pipe(
    Effect.result,
  )
  if (Result.isFailure(located) || located.success[2].type !== "File") {
    return yield* Effect.fail(
      kind === "Directory"
        ? `names the main directory ${target.target}, which holds no index.js file`
        : `names the entry ${target.target}, which is not a file`,
    )
  }
  const [home, resolved] = located.success
  if (!resolved.startsWith(home + path.sep)) {
    return yield* Effect.fail(
      `names the entry ${target.target}, which resolves to ${resolved}, outside the package directory ${home}. Spindle imports only files inside a package.`,
    )
  }
  return entry
})
