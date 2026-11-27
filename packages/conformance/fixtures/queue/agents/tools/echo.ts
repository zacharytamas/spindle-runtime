import fs from "node:fs"
import path from "node:path"
import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "Return the text it is given",
  args: z.object({ text: z.string() }),
  execute: async (_state, { text }) => {
    fs.appendFileSync(path.join(process.env.SPINDLE_GATE_DIR ?? ".", "tool-log"), `echo ${text}\n`)
    return { status: "success", result: text }
  },
})
