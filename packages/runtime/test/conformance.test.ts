import { describe, it } from "vitest"
import { stepLoopScenarios } from "../../conformance/src/scenarios/step-loop.ts"
import { spindleDriver } from "./spindle-driver.ts"

describe("step loop", () => {
  for (const scenario of stepLoopScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})
