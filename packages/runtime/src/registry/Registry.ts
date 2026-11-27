import { Context, Effect, type FileSystem, Layer, type Path, Result } from "effect"
import { type Definition, type Issue, issue, type Kind, type Package } from "./definition.ts"
import { loadDirectory } from "./load-directory.ts"
import {
  describeCause,
  describeImportFailure,
  type ImportFile,
  type LoadError,
  loadFailure,
  loadValue,
} from "./load-error.ts"
import { loadPackages, packageDirs } from "./load-packages.ts"
import { definitionIndex, indexName } from "./resolve.ts"

export class Registry extends Context.Service<
  Registry,
  ReturnType<typeof definitionIndex> & {
    readonly root: string
    readonly definitions: ReadonlyArray<Definition>
    readonly packages: ReadonlyArray<Package>
    readonly issues: ReadonlyArray<Issue>
  }
>()("spindle/Registry") {
  static readonly layer = (root: string): Layer.Layer<Registry, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      Registry,
      Effect.gen(function* () {
        const [local, npm] = yield* Effect.all([loadDirectory(root, importFile), packageDirs(root, "npm")], {
          concurrency: 2,
        })
        const packed = yield* loadPackages(root, importFile, npm.directories)
        const found = [...local.definitions, ...packed.definitions]
        const issues = [...local.issues, ...npm.issues, ...packed.issues]
        const results = yield* Effect.forEach(found, loadValue, { concurrency: 16 })
        const loadedNames = new Map<string, Definition>()
        const definitions = results.map(({ source, result }) => {
          const definition = finishLoad(source, result, issues)
          const earlier = Object.hasOwn(definition, "value") ? indexName(loadedNames, definition) : undefined
          if (earlier) {
            const location = earlier.path ? `${earlier.file}:${earlier.path}` : earlier.file
            const message = `${location} also defines the ${definition.kind} ${definition.qualifiedName}`
            issues.push(issue("definition_name_duplicate", definition.file, definition.path, message))
          }
          return definition
        })
        return {
          root,
          definitions,
          issues,
          packages: packed.packages,
          ...definitionIndex(definitions, packed.packages, issues),
        }
      }),
    )
}

// The spec names a definition by these fields. Tools, handlers, and effects have no such field, so their file name or export key names them.
const IDENTIFIER: Partial<Record<Kind, "name" | "id">> = { agent: "name", prompt: "name", model: "name", hook: "id" }

const finishLoad = (
  source: Definition,
  result: Result.Result<unknown, LoadError>,
  issues: Array<Issue>,
): Definition => {
  if (Result.isFailure(result)) {
    issues.push(...result.failure.issues)
    return source
  }
  const value = result.success
  const field = IDENTIFIER[source.kind]
  try {
    const declared =
      field !== undefined && typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined
    if (typeof declared !== "string" || declared === "" || declared === source.name) return { ...source, value }
    const origin = source.package === undefined ? "file name" : "export key"
    issues.push(
      issue(
        "definition_name_mismatch",
        source.file,
        [source.path, field].filter((part) => part !== "").join("."),
        `${source.kind} ${declared} has the ${origin} ${source.name}. Spindle finds it by its ${field}, ${declared}. Rename the ${origin} to match.`,
        "warning",
      ),
    )
    return {
      ...source,
      value,
      name: declared,
      qualifiedName: source.package === undefined ? declared : `${source.package.signature.packageId}/${declared}`,
    }
  } catch (cause) {
    const message = `The ${source.kind} threw while Spindle read its identifier. ${describeCause(cause)}`
    issues.push(issue("definition_load_failed", source.file, source.path, message))
    return source
  }
}

const importFile: ImportFile = (file, url) => {
  const failure = (cause: unknown) =>
    loadFailure(cause, file, "", "The file failed to load. ", describeImportFailure(cause))
  return url.pipe(
    Effect.mapError(failure),
    Effect.flatMap((href) =>
      Effect.tryPromise({
        try: (): Promise<Record<string, unknown>> => import(href.href),
        catch: failure,
      }),
    ),
  )
}
