import { isVisibleInNamespace, type NamespaceContext, parseQualifiedName } from "@standardagents/spec"
import type { Definition, Kind, Package } from "./definition.ts"

export type Resolution =
  | { readonly _tag: "Found"; readonly definition: Definition }
  | { readonly _tag: "Hidden"; readonly definition: Definition }
  | { readonly _tag: "Missing" }

const key = (kind: Kind, packageId: string | undefined, name: string) => `${kind}\u0000${packageId ?? ""}\u0000${name}`

export class DefinitionIndex {
  private readonly entries = new Map<string, Array<Definition>>()

  add(definition: Definition) {
    const at = key(definition.kind, definition.package?.signature.packageId, definition.name)
    const bucket = this.entries.get(at)
    if (!bucket) {
      this.entries.set(at, [definition])
      return
    }
    const earlier = Object.hasOwn(definition, "value") ? bucket.find((d) => Object.hasOwn(d, "value")) : undefined
    bucket.push(definition)
    return earlier
  }

  entryAgent = (pkg: Package, name: string) =>
    this.entries.get(key("agent", pkg.signature.packageId, name))?.find((d) => d.package === pkg && d.name === name)

  resolve = (kind: Kind, name: string, from: NamespaceContext): Resolution => {
    const [packageId, shortName] = parseQualifiedName(name)
    const home = from.type === "packed" ? from.packageId : undefined
    const definition = this.entries.get(key(kind, packageId ?? home, shortName))?.[0]
    if (definition === undefined) return { _tag: "Missing" }
    const signature = definition.package?.signature
    const isEntryPoint = kind === "agent" && definition.package?.entryAgents.includes(shortName) === true
    return isVisibleInNamespace(signature && { __package: signature }, from, isEntryPoint)
      ? { _tag: "Found", definition }
      : { _tag: "Hidden", definition }
  }
}
