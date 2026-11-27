import { Effect, FileSystem, Path, Result } from "effect"
import { type Issue, issue, KINDS, type Kind, pluralKind } from "./definition.ts"
import { type Discovered, type ImportFile, LoadError } from "./load-error.ts"

const EXTENSIONS = [".ts", ".mts", ".js", ".mjs"]

// Node runs a file without import or export syntax as CommonJS, and its default export is then an empty object.
// No kind accepts an empty object, so it counts as no export on every runtime. An object that inherits its fields
// from another prototype is a definition.
const exportsNoDefinition = (value: unknown) =>
  value === undefined ||
  (typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).length === 0)

const loadDefault = Effect.fn(function* (
  kind: Kind,
  file: string,
  module: ReturnType<ImportFile>,
  exists: Effect.Effect<boolean>,
) {
  const result = yield* Effect.result(module)
  if (Result.isFailure(result)) {
    if (yield* exists) return yield* result.failure
    const message = `Cannot load ${file}. The file or its link target does not exist.`
    return yield* new LoadError({ issues: [issue("definition_load_failed", file, "", message)] })
  }
  if (!exportsNoDefinition(result.success.default)) return result.success.default
  const message = `The file exports no definition. Export the ${kind} definition as the default export.`
  return yield* new LoadError({ issues: [issue("definition_export_missing", file, "", message)] })
})

export const loadDirectory = Effect.fn("loadDirectory")(function* (root: string, importFile: ImportFile) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const definitions: Array<Discovered> = []
  const issues: Array<Issue> = []
  const agentsDir = path.join(root, "agents")
  // A failed check counts as present, so the read that follows reports the cause as an issue.
  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => true))
  if (!(yield* exists(agentsDir))) {
    issues.push({
      code: "agents_directory_missing",
      severity: "error",
      message: (yield* exists(root))
        ? `The directory ${root} has no agents directory. Run spindle validate on the project directory that holds agents/.`
        : `The directory ${root} does not exist`,
      file: "agents",
      path: "",
    })
    return { definitions, issues }
  }
  const directories = yield* Effect.forEach(
    KINDS,
    Effect.fn(function* (kind) {
      const dir = path.join(agentsDir, pluralKind(kind))
      const entries = (yield* exists(dir)) ? yield* Effect.result(fs.readDirectory(dir)) : Result.succeed([])
      return { kind, dir, entries }
    }),
    { concurrency: KINDS.length },
  )
  for (const { kind, dir, entries } of directories) {
    if (Result.isFailure(entries)) {
      const file = path.relative(root, dir)
      const message = `Spindle cannot read ${file} as a directory. ${entries.failure.message}`
      issues.push(issue("definition_load_failed", file, "", message))
      continue
    }
    for (const entry of entries.success.sort()) {
      const extension = path.extname(entry)
      if (!EXTENSIONS.includes(extension) || /\.d\.m?ts$/.test(entry) || entry.startsWith(".")) continue
      const name = path.basename(entry, extension)
      const absolute = path.join(dir, entry)
      const file = path.relative(root, absolute)
      const load = loadDefault(kind, file, importFile(file, path.toFileUrl(absolute)), exists(absolute))
      definitions.push({
        kind,
        name,
        qualifiedName: name,
        package: undefined,
        file,
        path: "",
        load,
      })
    }
  }
  return { definitions, issues }
})
