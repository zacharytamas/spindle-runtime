const PHASES = ["drain", "assemble", "call", "persist-response", "tools", "persist-results", "stop"] as const

export type Phase = (typeof PHASES)[number]

export interface TraceEntry {
  readonly step: number
  readonly phase: Phase
  readonly detail: string
}

export const formatTraceEntry = (entry: TraceEntry) =>
  `step ${entry.step} ${entry.phase.padEnd(16)} ${entry.detail}`.trimEnd()
