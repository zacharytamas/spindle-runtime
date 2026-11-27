import { expect, it, vi } from "vitest"
import { waitForAdmission } from "../src/scenarios/harness.ts"

it("rejects when admission never happens within the polling limit", async ({ onTestFinished }) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }).setTimerTickMode("nextTimerAsync")
  onTestFinished(() => {
    vi.useRealTimers()
  })
  await expect(waitForAdmission(async () => false)).rejects.toThrow(/admission/i)
})
