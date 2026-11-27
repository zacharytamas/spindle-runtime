import { describe, it, vi } from "vitest"
import { hookScenarios } from "../../conformance/src/scenarios/hooks.ts"
import { integrityScenarios } from "../../conformance/src/scenarios/integrity.ts"
import { messageScenarios } from "../../conformance/src/scenarios/messages.ts"
import { ownershipScenarios } from "../../conformance/src/scenarios/ownership.ts"
import { queueScenarios } from "../../conformance/src/scenarios/queue.ts"
import { runStatusScenarios } from "../../conformance/src/scenarios/run-status.ts"
import { S22 } from "../../conformance/src/scenarios/step-loop/provider-responses.ts"
import { stepLoopScenarios } from "../../conformance/src/scenarios/step-loop.ts"
import { spindleDriver } from "./spindle-driver.ts"

describe("step loop", () => {
  for (const scenario of stepLoopScenarios)
    it(scenario.name, ({ onTestFinished }) => {
      if (scenario === S22) {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }).setTimerTickMode("nextTimerAsync")
        onTestFinished(() => {
          vi.useRealTimers()
        })
      }
      return scenario.run(spindleDriver)
    })
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

describe("ownership", () => {
  for (const scenario of ownershipScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})

describe("run status", () => {
  for (const scenario of runStatusScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})

describe("integrity", () => {
  for (const scenario of integrityScenarios) it(scenario.name, () => scenario.run(spindleDriver))
})
