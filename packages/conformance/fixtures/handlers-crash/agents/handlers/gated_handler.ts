import fs from "node:fs"
import path from "node:path"
import { defineHandler } from "@standardagents/spec"

export default defineHandler({
  description: "Gated handler for cross-process crash recovery and CLI tests",
  execute: async (state, message) => {
    const label = message.content ?? ""
    const dir = process.env.SPINDLE_GATE_DIR
    if (dir !== undefined) {
      fs.appendFileSync(path.join(dir, "handler-log"), `${label}\n`)
      fs.writeFileSync(path.join(dir, `handler-entered-${label}`), "")
      if (fs.existsSync(path.join(dir, `hold-${label}`))) {
        while (!fs.existsSync(path.join(dir, `release-${label}`))) {
          if (state.execution?.abortSignal.aborted) break
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
    }
    if (label === "reply") {
      await state.injectMessage({ role: "assistant", content: "handler-replied" })
    }
    if (label === "throw") {
      throw new Error("handler exploded")
    }
  },
})
