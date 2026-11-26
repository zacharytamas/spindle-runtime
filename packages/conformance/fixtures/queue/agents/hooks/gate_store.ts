import fs from "node:fs"
import path from "node:path"
import { defineHook } from "@standardagents/spec"

export default defineHook({
  hook: "before_store_tool_result",
  id: "gate_store",
  execute: async (_state, _call, result) => {
    const dir = process.env.SPINDLE_GATE_DIR ?? "."
    if (fs.existsSync(path.join(dir, "hold-hook"))) {
      fs.writeFileSync(path.join(dir, "hook-entered"), "")
      while (!fs.existsSync(path.join(dir, "release-hook"))) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return result
  },
})
