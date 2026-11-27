import { isVisibleInNamespace, type NamespaceContext, parseQualifiedName } from "@standardagents/spec"
import { type Definition, type Issue, issue, type Kind, type Package } from "./definition.ts"

export type Resolution =
  | { readonly _tag: "Found"; readonly definition: Definition }
  | { readonly _tag: "Hidden"; readonly definition: Definition }
  | { readonly _tag: "Missing" }

const key = (kind: Kind, packageId: string | undefined, name: string) => `${kind}\u0000${packageId ?? ""}\u0000${name}`

export const indexName = (names: Map<string, Definition>, definition: Definition) => {
  const at = key(definition.kind, definition.package?.signature.packageId, definition.name)
  const earlier = names.get(at)
  if (!earlier) names.set(at, definition)
  return earlier
}

export const definitionIndex = (
  definitions: ReadonlyArray<Definition>,
  packages: ReadonlyArray<Package>,
  issues: Array<Issue>,
) => {
  const agents = new Map(packages.map((pkg) => [pkg, new Map<string, Definition>()]))
  for (const definition of definitions) {
    if (definition.kind !== "agent" || !definition.package) continue
    const exports = agents.get(definition.package)
    if (exports && !exports.has(definition.name)) exports.set(definition.name, definition)
  }
  const entryAgent = (pkg: Package, name: string) => agents.get(pkg)?.get(name)
  for (const pkg of packages)
    for (const name of pkg.entryAgents)
      if (!entryAgent(pkg, name)) {
        const message = `${pkg.signature.packageId} lists entry agent ${name}, which it does not export`
        issues.push(issue("package_entry_agent_undefined", pkg.file, "", message))
      }

  // Identifier getters have finished and may have changed the shared package signature.
  const names = new Map<string, Definition>()
  for (const definition of definitions) indexName(names, definition)
  const resolve = (kind: Kind, name: string, from: NamespaceContext): Resolution => {
    const [packageId, shortName] = parseQualifiedName(name)
    const home = from.type === "packed" ? from.packageId : undefined
    const definition = names.get(key(kind, packageId ?? home, shortName))
    if (definition === undefined) return { _tag: "Missing" }
    const signature = definition.package?.signature
    const isEntryPoint = kind === "agent" && definition.package?.entryAgents.includes(shortName) === true
    return isVisibleInNamespace(signature && { __package: signature }, from, isEntryPoint)
      ? { _tag: "Found", definition }
      : { _tag: "Hidden", definition }
  }
  return { resolve, entryAgent }
}
