import type { Scenario } from "./harness.ts"
import { H15, H15b, H15c, H16, H23, H23b } from "./hooks/failure-and-timeout.ts"
import { H9, H9b, H9c, H10, H18, H20 } from "./hooks/message-writes.ts"
import { H11, H11b, H11c } from "./hooks/request-history.ts"
import { H22, H22b, H22c, H22d } from "./hooks/secrets.ts"
import { H8, H21 } from "./hooks/selection-and-context.ts"
import { H12, H12b, H12c, H12d, H12e, H13, H14 } from "./hooks/tool-lifecycle.ts"

export const hookScenarios: ReadonlyArray<Scenario> = [
  H8,
  H9,
  H9b,
  H9c,
  H10,
  H11,
  H11b,
  H11c,
  H12,
  H12e,
  H12b,
  H12c,
  H12d,
  H13,
  H14,
  H15,
  H15b,
  H15c,
  H16,
  H18,
  H20,
  H22,
  H22b,
  H22c,
  H22d,
  H23,
  H23b,
  H21,
]
