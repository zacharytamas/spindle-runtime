import { describe, expect, it } from "@effect/vitest"
import type { Definition, Kind, Package } from "../../src/registry/definition.ts"
import { DefinitionIndex } from "../../src/registry/resolve.ts"

const pkg = (packageId: string, entryAgents: ReadonlyArray<string>): Package => ({
  signature: { packageId, version: "1.0.0", source: "npm", packedAt: 0 },
  entryAgents,
  file: `node_modules/${packageId}/index.js`,
  manifestFile: `node_modules/${packageId}/package.json`,
  manifest: {},
  meta: {},
})

const packedA = pkg("packed-a", ["researcher"])
const packedB = pkg("packed-b", ["writer"])
const scoped = pkg("@scope/pkg", ["agent"])

const definition = (kind: Kind, name: string, owner?: Package): Definition => ({
  kind,
  name,
  qualifiedName: owner === undefined ? name : `${owner.signature.packageId}/${name}`,
  package: owner,
  file: owner?.file ?? `agents/${kind}s/${name}.ts`,
  path: "",
  value: {},
})

const definitions = [
  definition("tool", "search"),
  definition("agent", "assistant"),
  definition("tool", "search", packedA),
  definition("agent", "researcher", packedA),
  definition("agent", "helper", packedA),
  definition("prompt", "researcher", packedA),
  definition("tool", "search", packedB),
  definition("agent", "writer", packedB),
  definition("agent", "agent", scoped),
  definition("tool", "@scope/name"),
]

const index = new DefinitionIndex()
for (const definition of definitions) index.add(definition)
const { resolve } = index
const global = { type: "global" } as const
const insideA = { type: "packed", packageId: "packed-a" } as const

const found = (kind: Kind, name: string, from: typeof global | typeof insideA) => {
  const resolution = resolve(kind, name, from)
  return resolution._tag === "Found" ? resolution.definition.qualifiedName : resolution._tag
}

describe("resolve", () => {
  describe("visibility table", () => {
    it("lets global code see an unpacked definition", () => {
      expect(found("tool", "search", global)).toBe("search")
    })

    it("lets global code see a packed entry agent by its qualified name", () => {
      expect(found("agent", "packed-a/researcher", global)).toBe("packed-a/researcher")
      expect(found("agent", "researcher", global)).toBe("Missing")
    })

    it("hides the internals of a package from global code", () => {
      expect(found("tool", "packed-a/search", global)).toBe("Hidden")
      expect(found("agent", "packed-a/helper", global)).toBe("Hidden")
      expect(found("prompt", "packed-a/researcher", global)).toBe("Hidden")
    })

    it("hides unpacked definitions from packed code", () => {
      expect(found("agent", "assistant", insideA)).toBe("Missing")
    })

    it("lets packed code see the contents of its own package", () => {
      expect(found("tool", "search", insideA)).toBe("packed-a/search")
      expect(found("agent", "helper", insideA)).toBe("packed-a/helper")
      expect(found("tool", "packed-a/search", insideA)).toBe("packed-a/search")
    })

    it("lets packed code see the entry agents of another package", () => {
      expect(found("agent", "packed-b/writer", insideA)).toBe("packed-b/writer")
    })

    it("hides the internals of another package from packed code", () => {
      expect(found("tool", "packed-b/search", insideA)).toBe("Hidden")
    })

    it("keeps two packages that hold the same tool name apart", () => {
      const a = resolve("tool", "search", insideA)
      const b = resolve("tool", "search", { type: "packed", packageId: "packed-b" })
      expect(a._tag === "Found" && a.definition.package).toBe(packedA)
      expect(b._tag === "Found" && b.definition.package).toBe(packedB)
    })
  })

  describe("qualified names", () => {
    it("reads a name with no slash as unqualified", () => {
      expect(found("tool", "search", global)).toBe("search")
    })

    it("reads {packageId}/{name} as a qualified name", () => {
      expect(found("agent", "packed-b/writer", global)).toBe("packed-b/writer")
    })

    it("splits a scoped name at its second slash", () => {
      const resolution = resolve("agent", "@scope/pkg/agent", global)
      expect(resolution._tag).toBe("Found")
      if (resolution._tag !== "Found") return
      expect(resolution.definition.package?.signature.packageId).toBe("@scope/pkg")
      expect(resolution.definition.name).toBe("agent")
    })

    it("reads a scoped name with one slash as unqualified", () => {
      expect(found("tool", "@scope/name", global)).toBe("@scope/name")
    })

    it("reports a qualified name for a package that is not installed as missing", () => {
      expect(found("agent", "standardagent-absent/agent", global)).toBe("Missing")
    })
  })
})
