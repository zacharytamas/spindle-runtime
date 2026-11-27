import { Console, Effect, Path } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { type Definition, type Issue, KINDS, PLURAL, Registry } from "../registry/Registry.ts"
import { counts, type Validation, validate } from "../registry/validate.ts"

import { CommandFailed, commandErrors, plural } from "./shared.ts"

const location = (issue: Issue) => (issue.path === "" ? issue.file : `${issue.file}:${issue.path}`)

const ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r", "\u2028": "\\u2028", "\u2029": "\\u2029" }

const oneLine = (text: string) => text.replace(/[\n\r\u2028\u2029]/g, (separator) => ESCAPES[separator] ?? separator)

const listRow = (definition: Definition) => [
  definition.kind,
  definition.qualifiedName,
  definition.package?.signature.packageId ?? "-",
  definition.name,
  definition.package === undefined
    ? "global"
    : definition.kind === "agent" && definition.package.entryAgents.includes(definition.name)
      ? "entry"
      : "internal",
]

const table = (rows: ReadonlyArray<ReadonlyArray<string>>) => {
  const widths = rows.reduce<Array<number>>(
    (max, row) => row.map((cell, index) => Math.max(max[index] ?? 0, cell.length)),
    [],
  )
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join("  ")
      .trimEnd(),
  )
}

const formatText = ({ definitions, issues }: Validation, options: { readonly list: boolean }) => {
  const lines: Array<string> = []
  if (options.list) {
    const sorted = [...definitions].sort(
      (a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.qualifiedName.localeCompare(b.qualifiedName),
    )
    lines.push(...table([["KIND", "QUALIFIED NAME", "PACKAGE", "NAME", "VISIBILITY"], ...sorted.map(listRow)]))
  }
  for (const issue of issues) lines.push(oneLine(`${issue.code} ${issue.severity} ${location(issue)} ${issue.message}`))
  const count = counts(definitions)
  lines.push(KINDS.map((kind) => `${PLURAL[kind]} ${count[kind]}`).join(", "))
  const errors = issues.filter((issue) => issue.severity === "error").length
  lines.push(`${plural(errors, "error")}, ${plural(issues.length - errors, "warning")}`)
  return lines
}

const formatJson = ({ definitions, issues }: Validation, options: { readonly list: boolean }) => {
  const plain = issues.map(({ code, severity, message, file, path }) => ({ code, severity, message, file, path }))
  if (!options.list) return JSON.stringify(plain, null, 2)
  const rows = definitions.map((definition) => {
    const [kind, qualifiedName, packageId, name, visibility] = listRow(definition)
    return { kind, qualifiedName, packageId: packageId === "-" ? null : packageId, name, visibility }
  })
  return JSON.stringify({ definitions: rows, issues: plain }, null, 2)
}

export const validateCommand = Command.make(
  "validate",
  {
    dir: Argument.String("dir").pipe(
      Argument.withDescription("The project directory that holds agents/"),
      Argument.withDefault("."),
    ),
    json: Flag.Boolean("json").pipe(Flag.withDescription("Print the issues as JSON"), Flag.withDefault(false)),
    list: Flag.Boolean("list").pipe(
      Flag.withDescription("Print every definition by kind and qualified name"),
      Flag.withDefault(false),
    ),
  },
  ({ dir, json, list }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const result = yield* validate.pipe(Effect.provide(Registry.layer(path.resolve(dir))))
      if (json) yield* Console.log(formatJson(result, { list }))
      else for (const line of formatText(result, { list })) yield* Console.log(line)
      const errors = result.issues.filter((issue) => issue.severity === "error").length
      if (errors > 0) return yield* new CommandFailed()
    }).pipe(commandErrors()),
).pipe(Command.withDescription("Load the definitions in a project and report every issue"))
