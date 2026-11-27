import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "after_thread_created",
  id: "gate_created",
  execute: async () => {
    writeFileSync(join(process.env.SPINDLE_GATE_DIR ?? ".", "creation-entered"), "")
    await new Promise<void>(() => {})
  },
})
