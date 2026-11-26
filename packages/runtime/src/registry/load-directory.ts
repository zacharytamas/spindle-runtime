import { Effect, FileSystem, Path } from "effect"
import { type Definition, type Issue, importFile, KINDS, LoadError, PLURAL } from "./Registry.ts"

const EXTENSIONS = [".ts", ".mts", ".js", ".mjs"]

// Node runs a file without import or export syntax as CommonJS, and its default export is then an empty object.
// No kind accepts an empty object, so it counts as no export on every runtime.
const exportsNoDefinition = (value: unknown) =>
  value === undefined ||
  (typeof value === "object" && value !== null && !Array.isArray(value) && Reflect.ownKeys(value).length === 0)

export const loadDirectory = Effect.fn("loadDirectory")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const definitions: Array<Definition> = []
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
  for (const kind of KINDS) {
    const dir = path.join(agentsDir, PLURAL[kind])
    if (!(yield* exists(dir))) continue
    const entries = yield* fs.readDirectory(dir).pipe(
      Effect.catch((error) => {
        issues.push({
          code: "definition_load_failed",
          severity: "error",
          message: `Spindle cannot read ${path.relative(root, dir)} as a directory. ${error.message}`,
          file: path.relative(root, dir),
          path: "",
        })
        return Effect.succeed([])
      }),
    )
    const byName = new Map<string, string>()
    for (const entry of entries.sort()) {
      const extension = path.extname(entry)
      if (!EXTENSIONS.includes(extension) || /\.d\.m?ts$/.test(entry) || entry.startsWith(".")) continue
      const name = path.basename(entry, extension)
      const absolute = path.join(dir, entry)
      const file = path.relative(root, absolute)
      const earlier = byName.get(name)
      if (earlier !== undefined) {
        issues.push({
          code: "definition_name_duplicate",
          severity: "error",
          message: `${earlier} also defines the ${kind} ${name}`,
          file,
          path: "",
        })
        continue
      }
      byName.set(name, file)
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
        load: yield* Effect.cached(load),
      })
    }
  }
  return { definitions, issues }
})
