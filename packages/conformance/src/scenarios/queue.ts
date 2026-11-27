import type { Scenario } from "./harness.ts"
import { Q10, Q15, Q26, Q27, Q33, Q37, Q38, Q42 } from "./queue/admission.ts"
import { Q03, Q04, Q05, Q06, Q07, Q08, Q09, Q40, Q44 } from "./queue/delivery.ts"
import { Q17, Q28, Q29, Q30, Q31, Q32, Q41 } from "./queue/secrets.ts"
import { Q23, Q24, Q25, Q43 } from "./queue/step-cap.ts"
import { Q11, Q12, Q18, Q19, Q20, Q21, Q22 } from "./queue/stop.ts"
import { Q13, Q14, Q16, Q34, Q35, Q36, Q39 } from "./queue/termination.ts"

export const queueScenarios: ReadonlyArray<Scenario> = [
  Q03,
  Q04,
  Q05,
  Q06,
  Q07,
  Q08,
  Q09,
  Q10,
  Q11,
  Q12,
  Q13,
  Q14,
  Q15,
  Q16,
  Q17,
  Q18,
  Q19,
  Q20,
  Q21,
  Q22,
  Q23,
  Q24,
  Q25,
  Q43,
  Q26,
  Q27,
  Q41,
  Q28,
  Q29,
  Q30,
  Q31,
  Q32,
  Q33,
  Q42,
  Q34,
  Q35,
  Q36,
  Q37,
  Q38,
  Q39,
  Q40,
  Q44,
]
