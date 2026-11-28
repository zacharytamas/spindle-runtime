import type { PromptSide } from "@standardagents/spec"

export interface StepFacts {
  readonly text: string | null
  readonly calls: ReadonlyArray<{ readonly name: string }>
  readonly sideSteps: number
  readonly totalSteps: number
}

export interface StopRule {
  readonly reason: "stop_tool" | "stop_on_response" | "max_side_steps" | "max_total_steps"
  readonly applies: (step: StepFacts, side: PromptSide, stepCap: number) => boolean
}

// Runtime section 6 and Agents section 4 order the rules. The session bindings come first and arrive with M2.
export const STOP_RULES: ReadonlyArray<StopRule> = [
  {
    reason: "stop_tool",
    applies: (step, side) => side.stopTool !== undefined && step.calls.some((call) => call.name === side.stopTool),
  },
  {
    reason: "stop_on_response",
    applies: (step, side) =>
      side.stopOnResponse !== false && step.calls.length === 0 && (step.text ?? "").trim() !== "",
  },
  {
    reason: "max_side_steps",
    applies: (step, side) => side.maxSteps !== undefined && step.sideSteps >= side.maxSteps,
  },
  {
    reason: "max_total_steps",
    applies: (step, _side, stepCap) => step.totalSteps >= stepCap,
  },
]

export const stopReason = (step: StepFacts, side: PromptSide, stepCap: number) =>
  STOP_RULES.find((rule) => rule.applies(step, side, stepCap))?.reason

export const atRuntimeCap = (reason: string) =>
  reason === "max_session_turns" || reason === "max_total_steps" || reason === "max_total_turns"
