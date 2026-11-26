import { Effect, FileSystem, Path } from "effect"
import { type Definition, type Issue, importFile, KINDS, LoadError, PLURAL } from "./Registry.ts"

const EXTENSIONS = [".ts", ".mts", ".js", ".mjs"]

export const loadDirectory = Effect.fn("loadDirectory")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const definitions: Array<Definition> = []
  const issues: Array<Issue> = []
  const agentsDir = path.join(root, "agents")
  if (!(yield* fs.exists(agentsDir))) {
    issues.push({
      code: "agents_directory_missing",
      severity: "error",
      message: (yield* fs.exists(root))
        ? `The directory ${root} has no agents directory. Run spindle validate on the project directory that holds agents/.`
        : `The directory ${root} does not exist`,
      file: "agents",
      path: "",
    })
    return { definitions, issues }
  }
  for (const kind of KINDS) {
    const dir = path.join(agentsDir, PLURAL[kind])
    if (!(yield* fs.exists(dir))) continue
    const byName = new Map<string, string>()
    for (const entry of (yield* fs.readDirectory(dir)).sort()) {
      const extension = path.extname(entry)
      if (!EXTENSIONS.includes(extension) || entry.endsWith(".d.ts") || entry.startsWith(".")) continue
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
      const url = yield* path.toFileUrl(absolute)
      const load = importFile(file, url).pipe(
        Effect.flatMap((module) =>
          module.default === undefined
            ? Effect.fail(
                new LoadError({
                  issue: {
                    code: "definition_export_missing",
                    severity: "error",
                    message: `The file has no default export. Export the ${kind} definition as the default export.`,
                    file,
                    path: "",
                  },
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
