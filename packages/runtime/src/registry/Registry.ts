import type { NamespaceContext } from "@standardagents/spec"
import { Context, Effect, type FileSystem, Layer, type Path, Result } from "effect"
import type { Definition, Issue, Kind, Package } from "./definition.ts"
import { describeCause } from "./import-file.ts"
import { loadDirectory } from "./load-directory.ts"
import { loadPackages } from "./load-packages.ts"
import { type Resolution, resolver } from "./resolve.ts"

export class Registry extends Context.Service<
  Registry,
  {
    readonly root: string
    readonly definitions: ReadonlyArray<Definition>
    readonly packages: ReadonlyArray<Package>
    readonly loaded: ReadonlyMap<Definition, unknown>
    readonly issues: ReadonlyArray<Issue>
    readonly resolve: (kind: Kind, name: string, from: NamespaceContext) => Resolution
  }
>()("spindle/Registry") {
  static readonly layer = (root: string): Layer.Layer<Registry, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(
      Registry,
      Effect.gen(function* () {
        const local = yield* loadDirectory(root)
        const packed = yield* loadPackages(root)
        const found = [...local.definitions, ...packed.definitions]
        const issues = [...local.issues, ...packed.issues]
        const results = yield* Effect.forEach(found, (d) => Effect.result(d.load), { concurrency: 16 })
        const loaded = new Map<Definition, unknown>()
        const byKey = new Map<string, Definition>()
        const definitions = found.map((source, index) => {
          const result = results[index]
          if (result === undefined || Result.isFailure(result)) {
            if (result !== undefined) issues.push(...result.failure.issues)
            return source
          }
          let definition: Definition
          try {
            definition = identified(source, result.success, issues)
          } catch (cause) {
            issues.push({
              code: "definition_load_failed",
              severity: "error",
              message: `The ${source.kind} threw while Spindle read its identifier. ${describeCause(cause)}`,
              file: source.file,
              path: source.path,
            })
            return source
          }
          loaded.set(definition, result.success)
          const key = `${definition.kind}\u0000${definition.package?.signature.packageId ?? ""}\u0000${definition.name}`
          const earlier = byKey.get(key)
          if (earlier === undefined) byKey.set(key, definition)
          else
            issues.push({
              code: "definition_name_duplicate",
              severity: "error",
              message: `${earlier.file}${earlier.path === "" ? "" : `:${earlier.path}`} also defines the ${definition.kind} ${definition.qualifiedName}`,
              file: definition.file,
              path: definition.path,
            })
          return definition
        })
        for (const pkg of packed.packages)
          for (const agent of pkg.entryAgents)
            if (!definitions.some((d) => d.package === pkg && d.kind === "agent" && d.name === agent))
              issues.push({
                code: "package_entry_agent_undefined",
                severity: "error",
                message: `${pkg.signature.packageId} lists entry agent ${agent}, which it does not export`,
                file: pkg.file,
                path: "",
              })
        return {
          root,
          definitions,
          loaded,
          packages: packed.packages,
          issues,
          resolve: resolver(definitions),
        }
      }),
    )
}

// The spec names a definition by these fields. Tools, handlers, and effects have no such field, so their file name or export key names them.
const IDENTIFIER: Partial<Record<Kind, "name" | "id">> = { agent: "name", prompt: "name", model: "name", hook: "id" }

const identified = (source: Definition, value: unknown, issues: Array<Issue>): Definition => {
  const field = IDENTIFIER[source.kind]
  const declared =
    field !== undefined && typeof value === "object" && value !== null ? Reflect.get(value, field) : undefined
  if (typeof declared !== "string" || declared === "" || declared === source.name) return source
  const origin = source.package === undefined ? "file name" : "export key"
  issues.push({
    code: "definition_name_mismatch",
    severity: "warning",
    message: `${source.kind} ${declared} has the ${origin} ${source.name}. Spindle finds it by its ${field}, ${declared}. Rename the ${origin} to match.`,
    file: source.file,
    path: [source.path, field].filter((part) => part !== "").join("."),
  })
  return {
    ...source,
    name: declared,
    qualifiedName: source.package === undefined ? declared : `${source.package.signature.packageId}/${declared}`,
  }
}
