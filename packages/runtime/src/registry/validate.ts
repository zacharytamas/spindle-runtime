import { Effect, Predicate } from "effect"
import { checks, type Edge, site } from "./check-definition.ts"
import { type Definition, type Issue, KINDS, type Kind } from "./definition.ts"
import { describeCause } from "./import-file.ts"
import { Registry } from "./Registry.ts"

type Edges = ReadonlyMap<Definition, ReadonlyArray<Edge>>

const cyclesOf = (edges: Edges) => {
  const cycles: Array<{ definition: Definition; cycle: ReadonlyArray<Definition>; path: string }> = []
  const done = new Set<Definition>()
  const visit = (definition: Definition, trail: ReadonlyArray<Definition>) => {
    if (done.has(definition)) return
    const start = trail.indexOf(definition)
    if (start !== -1) {
      const cycle = trail.slice(start)
      const edge = edges.get(definition)?.find((e) => e.target === (cycle[1] ?? definition))
      cycles.push({ definition, cycle, path: edge?.path ?? "" })
      return
    }
    for (const edge of edges.get(definition) ?? []) visit(edge.target, [...trail, definition])
    done.add(definition)
  }
  for (const definition of [...edges.keys()].sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName)))
    visit(definition, [])
  return cycles
}

// A caller reads inherited fields too, so keys come from for...in.
const keysOf = (value: Record<string, unknown>) => {
  const keys: Array<string> = []
  for (const key in value) keys.push(key)
  return keys
}

// Array.from reads a missing element as undefined, where every() would skip it.
const sameValue = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      Array.from(a, (item, i) => sameValue(item, b[i])).every(Boolean)
    )
  if (Predicate.isObject(a) && Predicate.isObject(b)) {
    const keys = keysOf(a)
    const other = keysOf(b)
    return keys.length === other.length && keys.every((key) => other.includes(key) && sameValue(a[key], b[key]))
  }
  return Object.is(a, b)
}

const listed = (names: ReadonlyArray<string>) => `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`

export interface Validation {
  readonly definitions: ReadonlyArray<Definition>
  readonly issues: ReadonlyArray<Issue>
}

const checkDisclosures = (registry: Registry["Service"], issues: Array<Issue>) => {
  for (const pkg of registry.packages) {
    try {
      for (const agentName of pkg.entryAgents) {
        const agent = registry.entryAgent(pkg, agentName)?.value
        if (!Predicate.isObject(agent) || agent.parentHooks === undefined) continue
        const sources = [
          ["__meta", "parentHooks", pkg.meta.parentHooks, pkg.file],
          [
            "package.json",
            "standardagent.parentHooks",
            Predicate.isObject(pkg.manifest.standardagent) ? pkg.manifest.standardagent.parentHooks : undefined,
            pkg.manifestFile,
          ],
        ] as const
        for (const [label, field, value, file] of sources) {
          const copy = Predicate.isObject(value) ? value[agentName] : undefined
          if (!sameValue(copy, agent.parentHooks))
            issues.push({
              code: "package_parent_hooks_mismatch",
              severity: "error",
              message: `${pkg.signature.packageId} must reproduce the parentHooks of entry agent ${agentName} in ${label}`,
              file,
              path: `${field}.${agentName}`,
            })
        }
      }
    } catch (cause) {
      issues.push({
        code: "package_invalid",
        severity: "error",
        message: `${pkg.signature.packageId} threw while Spindle compared its parentHooks disclosures. ${describeCause(cause)}`,
        file: pkg.file,
        path: "",
      })
    }
  }
}

const order = (issue: Issue) => `${issue.file}\u0000${issue.path}\u0000${issue.code}`

export const validate = Effect.map(Registry, (registry): Validation => {
  const issues = [...registry.issues]
  const edges = new Map<Definition, ReadonlyArray<Edge>>()
  for (const definition of registry.definitions) {
    if (!Object.hasOwn(definition, "value")) continue
    const at = site(registry, issues, definition)
    try {
      const targets = checks[definition.kind](at, definition.value)
      if (targets) edges.set(definition, targets)
    } catch (cause) {
      at.report(
        "definition_load_failed",
        "",
        `The ${definition.kind} threw while Spindle checked it. ${describeCause(cause)}`,
      )
    }
  }
  for (const { definition, cycle, path } of cyclesOf(edges)) {
    const names = cycle.map((d) => d.qualifiedName)
    const at = site(registry, issues, definition)
    if (definition.kind === "prompt")
      at.report(
        "prompt_include_circular",
        path,
        cycle.length === 1
          ? `Prompt ${names[0]} includes itself`
          : `Prompts ${listed(names)} include each other (${[...names, names[0]].join(" -> ")})`,
      )
    else if (cycle.length > 1)
      at.report(
        "model_fallback_circular",
        path,
        `Models ${listed(names)} name each other as fallbacks (${[...names, names[0]].join(" -> ")}). A fallback chain that returns to its first model does not end.`,
        "warning",
      )
  }
  checkDisclosures(registry, issues)
  issues.sort((a, b) => order(a).localeCompare(order(b)))
  return { definitions: registry.definitions, issues }
})

export const counts = (definitions: ReadonlyArray<Definition>) =>
  Object.fromEntries(KINDS.map((kind) => [kind, definitions.filter((d) => d.kind === kind).length])) as Record<
    Kind,
    number
  >
