import { describe, it } from "vitest"
import { hookScenarios } from "../../conformance/src/scenarios/hooks.ts"
import { integrityScenarios } from "../../conformance/src/scenarios/integrity.ts"
import { messageScenarios } from "../../conformance/src/scenarios/messages.ts"
import { queueScenarios } from "../../conformance/src/scenarios/queue.ts"
import { runStatusScenarios } from "../../conformance/src/scenarios/run-status.ts"
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

describe("queue", () => {
  for (const scenario of queueScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})

describe("run status", () => {
  for (const scenario of runStatusScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})

describe("integrity", () => {
  for (const scenario of integrityScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})
