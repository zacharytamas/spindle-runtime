import type { Scenario } from "./harness.ts"
import { M8, M8b, M8c, M8d } from "./messages/history-snapshot.ts"
import { M1, M2, M3 } from "./messages/injection.ts"
import { M4, M5, M5b, M6, M7, M7b } from "./messages/request-hooks.ts"

// Messages section 7, one scenario per row, each with the human on side B and then on side A.
export const messageScenarios: ReadonlyArray<Scenario> = [M1, M2, M3, M4, M5, M5b, M6, M7, M8, M8b, M8c, M8d, M7b]
