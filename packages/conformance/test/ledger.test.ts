import { Result } from "effect"
import { describe, expect, it } from "vitest"
import {
  checkLedger,
  decodeLedger,
  duplicateKeys,
  type Ledger,
  MAX_REQUIREMENTS_PER_TEST,
  testStatuses,
} from "../src/ledger.ts"

const TEST = "packages/runtime/test/store/contract.test.ts > ThreadStore > appends a message"
const planned = { status: "planned", milestone: "M1", tests: [], reason: "" } as const
const covered = { status: "covered", milestone: "M1", tests: [TEST], reason: "" } as const
const passing = new Map([[TEST, ["passed"]]])

describe("checkLedger", () => {
  it("accepts one entry per requirement whose covered tests passed", () => {
    const ledger: Ledger = { "threads:aaaa": planned, "threads:bbbb": covered }
    expect(checkLedger(["threads:aaaa", "threads:bbbb"], ledger, passing)).toEqual([])
  })

  it("fails when a requirement id has no ledger entry", () => {
    expect(checkLedger(["threads:aaaa", "threads:bbbb"], { "threads:aaaa": planned }, passing)).toEqual([
      "threads:bbbb has no ledger entry",
    ])
  })

  it("fails when a covered entry names no test", () => {
    const ledger: Ledger = { "threads:aaaa": { ...covered, tests: [] } }
    expect(checkLedger(["threads:aaaa"], ledger, passing)).toEqual(["threads:aaaa is covered but names no test"])
  })

  it("fails when a named test does not exist", () => {
    const ledger: Ledger = { "threads:aaaa": { ...covered, tests: [`${TEST} twice`] } }
    expect(checkLedger(["threads:aaaa"], ledger, passing)).toEqual([
      `threads:aaaa names a test that does not exist: ${TEST} twice`,
    ])
  })

  it("fails when a ledger id is absent from requirements.json", () => {
    const ledger: Ledger = { "threads:aaaa": planned, "threads:cccc": planned }
    expect(checkLedger(["threads:aaaa"], ledger, passing)).toEqual([
      "threads:cccc is stale because requirements.json does not contain it",
    ])
  })

  it("fails when a named test did not pass", () => {
    expect(checkLedger(["threads:aaaa"], { "threads:aaaa": covered }, new Map([[TEST, ["skipped"]]]))).toEqual([
      `threads:aaaa names a test that did not pass (skipped): ${TEST}`,
    ])
  })

  it("fails when two tests share the name that an entry cites", () => {
    expect(
      checkLedger(["threads:aaaa"], { "threads:aaaa": covered }, new Map([[TEST, ["skipped", "passed"]]])),
    ).toEqual([`threads:aaaa names a test that 2 tests share: ${TEST}`])
  })

  it("fails when more requirement ids than the cap name one test", () => {
    const ids = Array.from({ length: MAX_REQUIREMENTS_PER_TEST + 1 }, (_, index) => `threads:${index}`)
    const ledger: Ledger = Object.fromEntries(ids.map((id) => [id, covered]))
    expect(checkLedger(ids, ledger, passing)).toEqual([
      `${TEST} is named by ${MAX_REQUIREMENTS_PER_TEST + 1} requirement ids, more than ${MAX_REQUIREMENTS_PER_TEST}`,
    ])
  })

  it("fails when a covered entry cites a test of the ledger tool", () => {
    const tool = "packages/conformance/test/ledger.test.ts > checkLedger > accepts one entry"
    const ledger: Ledger = { "threads:aaaa": { ...covered, tests: [tool] } }
    expect(checkLedger(["threads:aaaa"], ledger, new Map([[tool, ["passed"]]]))).toEqual([
      `threads:aaaa is covered by a test of the ledger tool, not of the runtime: ${tool}`,
    ])
  })

  it("fails when the Vitest report holds a failed test that no entry cites", () => {
    const failing = "packages/runtime/test/other.test.ts > other > breaks"
    const tests = new Map([...passing, [failing, ["failed"]]])
    expect(checkLedger(["threads:aaaa"], { "threads:aaaa": covered }, tests)).toEqual([
      `${failing} failed in the Vitest report`,
    ])
  })
})

describe("duplicateKeys", () => {
  it("finds a ledger id that appears twice, which JSON.parse would drop", () => {
    const json = `{\n\t"threads:aaaa": { "reason": "{\\"x\\": 1}" },\n\t"threads:bbbb": {},\n\t"threads:aaaa": {}\n}\n`
    expect(duplicateKeys(json)).toEqual(["threads:aaaa"])
  })
})

describe("decodeLedger", () => {
  it("fails on a field that the entry format does not have", () => {
    expect(decodeLedger({ "threads:aaaa": { ...planned, extra: 1 } })).toEqual(
      Result.fail(`ledger.json: Expected no excess property at ["threads:aaaa"]["extra"]`),
    )
  })

  it("names the entry and the field of a schema error on one line", () => {
    expect(decodeLedger({ "threads:aaaa": { ...planned, status: "done" } })).toEqual(
      Result.fail(
        `ledger.json: Expected "covered" | "planned" | "deferred" | "not-testable" at ["threads:aaaa"]["status"]`,
      ),
    )
  })
})

describe("testStatuses", () => {
  it("names a test by its file relative to the root, its describe blocks, and its title", () => {
    const report = {
      testResults: [
        {
          name: "/repo/packages/runtime/test/store/contract.test.ts",
          status: "passed",
          assertionResults: [{ ancestorTitles: ["ThreadStore"], title: "appends a message", status: "passed" }],
        },
      ],
    }
    expect(testStatuses(report, "/repo")).toEqual(passing)
  })

  it("names a test with forward slashes when the paths use backslashes", () => {
    const report = {
      testResults: [
        {
          name: "C:\\repo\\packages\\runtime\\test\\store\\contract.test.ts",
          status: "passed",
          assertionResults: [{ ancestorTitles: ["ThreadStore"], title: "appends a message", status: "passed" }],
        },
      ],
    }
    expect(testStatuses(report, "C:\\repo")).toEqual(passing)
  })
})
