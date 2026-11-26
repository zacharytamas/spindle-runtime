import { describe, it } from "vitest"
import { hookScenarios } from "../../conformance/src/scenarios/hooks.ts"
import { messageScenarios } from "../../conformance/src/scenarios/messages.ts"
import { stepLoopScenarios } from "../../conformance/src/scenarios/step-loop.ts"
import { spindleDriver } from "./spindle-driver.ts"

describe("step loop", () => {
  for (const scenario of stepLoopScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})

describe("messages", () => {
  for (const scenario of messageScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})

describe("hooks", () => {
  for (const scenario of hookScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})
