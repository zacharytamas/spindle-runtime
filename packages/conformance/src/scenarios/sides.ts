import type { Scenario } from "./harness.ts"
import { T12 } from "./sides/context.ts"
import { T13 } from "./sides/crash.ts"
import { T01, T02, T03, T04 } from "./sides/dual-prompt.ts"
import { T09, T10, T11 } from "./sides/force-turn.ts"
import { T05, T06, T07, T08 } from "./sides/session-turns.ts"

export const sideScenarios: ReadonlyArray<Scenario> = [T01, T02, T03, T04, T05, T06, T07, T08, T09, T10, T11, T12, T13]
