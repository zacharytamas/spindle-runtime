import { isVisibleInNamespace, type NamespaceContext, parseQualifiedName } from "@standardagents/spec"
import type { Definition, Kind } from "./Registry.ts"

export type Resolution =
  | { readonly _tag: "Found"; readonly definition: Definition }
  | { readonly _tag: "Hidden"; readonly definition: Definition }
  | { readonly _tag: "Missing" }

const key = (kind: Kind, packageId: string | undefined, name: string) => `${kind}\u0000${packageId ?? ""}\u0000${name}`

export const resolver = (definitions: ReadonlyArray<Definition>) => {
  const index = new Map<string, Definition>()
  for (const d of definitions) {
    const at = key(d.kind, d.package?.signature.packageId, d.name)
    if (!index.has(at)) index.set(at, d)
  }
  return (kind: Kind, name: string, from: NamespaceContext): Resolution => {
    const [packageId, shortName] = parseQualifiedName(name)
    const home = from.type === "packed" ? from.packageId : undefined
    const definition = index.get(key(kind, packageId ?? home, shortName))
    if (definition === undefined) return { _tag: "Missing" }
    const signature = definition.package?.signature
    const isEntryPoint = kind === "agent" && definition.package?.entryAgents.includes(shortName) === true
    return isVisibleInNamespace(signature && { __package: signature }, from, isEntryPoint)
      ? { _tag: "Found", definition }
      : { _tag: "Hidden", definition }
  }
}
