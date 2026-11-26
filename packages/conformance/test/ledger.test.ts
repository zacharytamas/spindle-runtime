import { describe, expect, it } from "vitest"
import { checkLedger, type Ledger, testStatuses } from "../src/ledger.ts"

const TEST = "packages/runtime/test/store/contract.test.ts > ThreadStore > appends a message"
const planned = { status: "planned", milestone: "M1", tests: [], reason: "" } as const
const covered = { status: "covered", milestone: "M1", tests: [TEST], reason: "" } as const
const passing = new Map([[TEST, "passed"]])

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
    expect(checkLedger(["threads:aaaa"], { "threads:aaaa": covered }, new Map([[TEST, "skipped"]]))).toEqual([
      `threads:aaaa names a test that did not pass (skipped): ${TEST}`,
    ])
  })
})

describe("testStatuses", () => {
  it("names a test by its file relative to the root, its describe blocks, and its title", () => {
    const report = {
      testResults: [
        {
          name: "/repo/packages/runtime/test/store/contract.test.ts",
          assertionResults: [{ ancestorTitles: ["ThreadStore"], title: "appends a message", status: "passed" }],
        },
      ],
    }
    expect(testStatuses(report, "/repo")).toEqual(passing)
  })
})
