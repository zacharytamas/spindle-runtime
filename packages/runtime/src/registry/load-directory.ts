import { Effect, FileSystem, Path, Result } from "effect"
import { type Issue, KINDS, PLURAL } from "./definition.ts"
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
      const dir = path.join(agentsDir, PLURAL[kind])
      const entries = (yield* exists(dir)) ? yield* Effect.result(fs.readDirectory(dir)) : Result.succeed([])
      return { kind, dir, entries }
    }),
    { concurrency: KINDS.length },
  )
  for (const { kind, dir, entries } of directories) {
    if (Result.isFailure(entries)) {
      const file = path.relative(root, dir)
      issues.push({
        code: "definition_load_failed",
        severity: "error",
        message: `Spindle cannot read ${file} as a directory. ${entries.failure.message}`,
        file,
        path: "",
      })
      continue
    }
    for (const entry of entries.success.sort()) {
      const extension = path.extname(entry)
      if (!EXTENSIONS.includes(extension) || /\.d\.m?ts$/.test(entry) || entry.startsWith(".")) continue
      const name = path.basename(entry, extension)
      const absolute = path.join(dir, entry)
      const file = path.relative(root, absolute)
      const load = importFile(file, path.toFileUrl(absolute)).pipe(
        Effect.flatMap((module) =>
          exportsNoDefinition(module.default)
            ? Effect.fail(
                new LoadError({
                  issues: [
                    {
                      code: "definition_export_missing",
                      severity: "error",
                      message: `The file exports no definition. Export the ${kind} definition as the default export.`,
                      file,
                      path: "",
                    },
                  ],
                }),
              )
            : Effect.succeed(module.default),
        ),
      )
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
