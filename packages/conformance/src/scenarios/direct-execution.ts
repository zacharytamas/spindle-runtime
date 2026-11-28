import { DE04, DE05, DE06, DE07 } from "./direct-execution/at-rest-invoke.ts"
import { DE01, DE02, DE03 } from "./direct-execution/hook-invoke.ts"
import { DE08, DE09, DE10 } from "./direct-execution/run-agent.ts"
import type { Scenario } from "./harness.ts"

export const directExecutionScenarios: ReadonlyArray<Scenario> = [
  DE01,
  DE02,
  DE03,
  DE04,
  DE05,
  DE06,
  DE07,
  DE08,
  DE09,
  DE10,
]
