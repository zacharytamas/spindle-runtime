import type { Scenario } from "./harness.ts"
import { O13, O14, O15, O16, O17, O18 } from "./ownership/call-history.ts"
import { O05, O06, O07, O19, O20, O21, O22, O23 } from "./ownership/holder-lifecycle.ts"
import { O01, O02, O03, O04, O08, O09, O10, O11, O12 } from "./ownership/write-fencing.ts"

export const ownershipScenarios: ReadonlyArray<Scenario> = [
  O01,
  O02,
  O03,
  O04,
  O05,
  O06,
  O07,
  O08,
  O09,
  O10,
  O11,
  O12,
  O13,
  O14,
  O15,
  O16,
  O17,
  O18,
  O19,
  O20,
  ...O21,
  O22,
  O23,
]
