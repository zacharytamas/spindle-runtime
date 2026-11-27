import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { Result, Schema, type SchemaAST } from "effect"

export const MAX_REQUIREMENTS_PER_TEST = 8

const LedgerEntry = Schema.Struct({
  status: Schema.Literals(["covered", "partial", "planned", "deferred", "not-testable"]),
  milestone: Schema.Literals(["M1", "M2", "M3", "M4", "M5", "M6", "M7", "later", "none"]),
  tests: Schema.Array(Schema.String),
  reason: Schema.String,
})

const Ledger = Schema.Record(Schema.String, LedgerEntry)
export type Ledger = typeof Ledger.Type

const Requirements = Schema.Array(Schema.Struct({ id: Schema.String }))

const VitestReport = Schema.Struct({
  testResults: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      assertionResults: Schema.Array(
        Schema.Struct({ ancestorTitles: Schema.Array(Schema.String), title: Schema.String, status: Schema.String }),
      ),
    }),
  ),
})

const decode =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S, file: string, options?: SchemaAST.ParseOptions) =>
  (input: unknown): Result.Result<S["Type"], string> =>
    Result.mapError(
      Schema.decodeUnknownResult(schema, options)(input),
      (error) => `${file}: ${error.message.replaceAll(/\s*\n\s*/g, " ")}`,
    )

export const decodeLedger = decode(Ledger, "ledger.json", { onExcessProperty: "error" })

export const duplicateKeys = (json: string): Array<string> => {
  const duplicates: Array<string> = []
  const frames: Array<{ readonly path: string; readonly seen: Set<string>; last: string }> = []
  for (const [token, key, colon] of json.matchAll(/("(?:[^"\\]|\\.)*")(\s*:)?|[{}[\]]/g)) {
    const frame = frames.at(-1)
    if (token === "{" || token === "[") {
      frames.push({ path: frame === undefined ? "" : `${frame.path}${frame.last}.`, seen: new Set(), last: "" })
    } else if (token === "}" || token === "]") frames.pop()
    else if (frame !== undefined && key !== undefined && colon !== undefined) {
      const name: string = JSON.parse(key)
      if (frame.seen.has(name)) duplicates.push(`${frame.path}${name}`)
      frame.seen.add(name)
      frame.last = name
    }
  }
  return duplicates
}

const slashes = (file: string) => file.replaceAll("\\", "/")

export const testStatuses = (
  report: typeof VitestReport.Type,
  root: string,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const statuses = new Map<string, Array<string>>()
  const add = (name: string, status: string) => statuses.set(name, [...(statuses.get(name) ?? []), status])
  for (const file of report.testResults) {
    const relative = path.posix.relative(slashes(root), slashes(file.name))
    if (file.status === "failed") add(relative, "failed")
    for (const test of file.assertionResults)
      add([relative, ...test.ancestorTitles, test.title].join(" > "), test.status)
  }
  return statuses
}

export const checkLedger = (
  requirementIds: ReadonlyArray<string>,
  ledger: Ledger,
  tests: ReadonlyMap<string, ReadonlyArray<string>>,
): Array<string> => {
  const problems: Array<string> = []
  for (const [test, statuses] of tests) {
    if (statuses.includes("failed")) problems.push(`${test} failed in the Vitest report`)
  }
  const known = new Set(requirementIds)
  for (const id of requirementIds) {
    if (!Object.hasOwn(ledger, id)) problems.push(`${id} has no ledger entry`)
  }
  const citations = new Map<string, number>()
  for (const [id, entry] of Object.entries(ledger)) {
    if (!known.has(id)) {
      problems.push(`${id} is stale because requirements.json does not contain it`)
      continue
    }
    const claimsCoverage = entry.status === "covered" || entry.status === "partial"
    if (claimsCoverage && entry.tests.length === 0) problems.push(`${id} is ${entry.status} but names no test`)
    if (entry.status !== "covered" && entry.status !== "planned" && entry.reason.trim() === "")
      problems.push(`${id} is ${entry.status} but gives no reason`)
    for (const test of entry.tests) {
      citations.set(test, (citations.get(test) ?? 0) + 1)
      if (claimsCoverage && test.toLowerCase().startsWith("packages/conformance/test/"))
        problems.push(`${id} is covered by a test of the ledger tool, not of the runtime: ${test}`)
      const statuses = tests.get(test)
      if (statuses === undefined) problems.push(`${id} names a test that does not exist: ${test}`)
      else if (statuses.length > 1) problems.push(`${id} names a test that ${statuses.length} tests share: ${test}`)
      else if (statuses[0] !== "passed") problems.push(`${id} names a test that did not pass (${statuses[0]}): ${test}`)
    }
  }
  for (const [test, count] of citations) {
    if (count > MAX_REQUIREMENTS_PER_TEST)
      problems.push(`${test} is named by ${count} requirement ids, more than ${MAX_REQUIREMENTS_PER_TEST}`)
  }
  return problems
}

if (import.meta.main) {
  const [reportFile] = process.argv.slice(2)
  if (reportFile === undefined) {
    console.error("Usage: node packages/conformance/src/ledger.ts <vitest-json-report>")
    process.exit(2)
  }
  const conformance = path.join(import.meta.dirname, "..")
  const read = (file: string) => fs.readFileSync(file, "utf8")
  const orExit = <A>(result: Result.Result<A, string>): A => {
    if (Result.isSuccess(result)) return result.success
    console.error(result.failure)
    process.exit(1)
  }
  const ledgerText = read(path.join(conformance, "ledger.json"))
  const requirementIds = orExit(
    decode(Requirements, "requirements.json")(JSON.parse(read(path.join(conformance, "requirements.json")))),
  ).map((requirement) => requirement.id)
  const ledger = orExit(decodeLedger(JSON.parse(ledgerText)))
  const tests = testStatuses(
    orExit(decode(VitestReport, reportFile)(JSON.parse(read(reportFile)))),
    path.join(conformance, "../.."),
  )
  const problems = [
    ...duplicateKeys(ledgerText).map((key) => `${key} appears more than once in ledger.json`),
    ...checkLedger(requirementIds, ledger, tests),
  ]
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    console.error(`ledger failed, ${problems.length} problems`)
    process.exit(1)
  }
  const count = (status: string) => Object.values(ledger).filter((entry) => entry.status === status).length
  const partial = count("partial") === 0 ? "" : `, ${count("partial")} partial`
  const m1 = Object.values(ledger).filter((entry) => entry.milestone === "M1")
  const inM1 = (status: string) => m1.filter((entry) => entry.status === status).length
  console.log(
    `ledger ok, ${requirementIds.length} requirements, ${count("covered")} covered${partial}, milestone 1 ${inM1("covered")} covered of ${m1.length}, ${inM1("planned")} planned`,
  )
}
