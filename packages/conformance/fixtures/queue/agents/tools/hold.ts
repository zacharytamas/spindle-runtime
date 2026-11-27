// Waits until release-<name> exists in SPINDLE_GATE_DIR. It writes tool-entered-<name> when it starts, and appends
// its name to tool-log, so that a test sees how often it ran. With watch, it also ends when the execution aborts.
import fs from "node:fs"
import path from "node:path"
import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "Wait until the test releases the named gate",
  args: z.object({ name: z.string(), watch: z.boolean().optional(), detached: z.boolean().optional() }),
  execute: async (state, { name, watch, detached }) => {
    if (detached) {
      void state.invokeTool("hold", { name }).catch(() => {})
      return { status: "success", result: "started nested hold" }
    }
    const dir = process.env.SPINDLE_GATE_DIR ?? "."
    const signal = state.execution?.abortSignal
    const recordAbort = () => fs.writeFileSync(path.join(dir, `tool-aborted-${name}`), "")
    if (watch) {
      if (signal?.aborted) recordAbort()
      else signal?.addEventListener("abort", recordAbort, { once: true })
    }
    fs.appendFileSync(path.join(dir, "tool-log"), `${name}\n`)
    fs.writeFileSync(path.join(dir, `tool-entered-${name}`), "")
    while (!fs.existsSync(path.join(dir, `release-${name}`))) {
      if (watch && signal?.aborted) return { status: "error", error: `hold ${name} saw the abort` }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (watch) signal?.removeEventListener("abort", recordAbort)
    return { status: "success", result: `released ${name}, aborted ${signal?.aborted ?? false}` }
  },
})
