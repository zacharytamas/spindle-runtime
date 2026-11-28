import { HD15 } from "./handlers/crash.ts"
import { HD04, HD05, HD06, HD07 } from "./handlers/delivery.ts"
import { HD08, HD09 } from "./handlers/errors.ts"
import { HD01, HD02, HD03 } from "./handlers/pairings.ts"
import { HD13, HD14 } from "./handlers/queued-tools.ts"
import { HD10, HD11, HD12 } from "./handlers/turns-and-stop.ts"
import type { Scenario } from "./harness.ts"

export const handlerScenarios: ReadonlyArray<Scenario> = [
  HD01,
  HD02,
  HD03,
  HD04,
  HD05,
  HD06,
  HD07,
  HD08,
  HD09,
  HD10,
  HD11,
  HD12,
  HD13,
  HD14,
  HD15,
]
