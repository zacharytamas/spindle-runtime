import fs from "node:fs"
import path from "node:path"
import process from "node:process"
import { Schema } from "effect"

const LedgerEntry = Schema.Struct({
  status: Schema.Literals(["covered", "planned", "deferred", "not-testable"]),
  milestone: Schema.String,
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
      assertionResults: Schema.Array(
        Schema.Struct({ ancestorTitles: Schema.Array(Schema.String), title: Schema.String, status: Schema.String }),
      ),
    }),
  ),
})

export const testStatuses = (report: typeof VitestReport.Type, root: string): ReadonlyMap<string, string> =>
  new Map(
    report.testResults.flatMap((file) =>
      file.assertionResults.map(
        (test) =>
          [[path.relative(root, file.name), ...test.ancestorTitles, test.title].join(" > "), test.status] as const,
      ),
    ),
  )

export const checkLedger = (
  requirementIds: ReadonlyArray<string>,
  ledger: Ledger,
  tests: ReadonlyMap<string, string>,
): Array<string> => {
  const problems: Array<string> = []
  const known = new Set(requirementIds)
  for (const id of requirementIds) {
    if (!Object.hasOwn(ledger, id)) problems.push(`${id} has no ledger entry`)
  }
  for (const [id, entry] of Object.entries(ledger)) {
    if (!known.has(id)) {
      problems.push(`${id} is stale because requirements.json does not contain it`)
      continue
    }
    if (entry.status === "covered" && entry.tests.length === 0) problems.push(`${id} is covered but names no test`)
    for (const test of entry.tests) {
      const status = tests.get(test)
      if (status === undefined) problems.push(`${id} names a test that does not exist: ${test}`)
      else if (status !== "passed") problems.push(`${id} names a test that did not pass (${status}): ${test}`)
    }
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
  const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"))
  const requirementIds = Schema.decodeUnknownSync(Requirements)(
    readJson(path.join(conformance, "requirements.json")),
  ).map((requirement) => requirement.id)
  const ledger = Schema.decodeUnknownSync(Ledger)(readJson(path.join(conformance, "ledger.json")))
  const tests = testStatuses(
    Schema.decodeUnknownSync(VitestReport)(readJson(reportFile)),
    path.join(conformance, "../.."),
  )
  const problems = checkLedger(requirementIds, ledger, tests)
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    console.error(`ledger failed, ${problems.length} problems`)
    process.exit(1)
  }
  const covered = Object.values(ledger).filter((entry) => entry.status === "covered").length
  console.log(`ledger ok, ${requirementIds.length} requirements, ${covered} covered`)
}
