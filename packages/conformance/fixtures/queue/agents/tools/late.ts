// Waits until release-<name> exists in SPINDLE_GATE_DIR, then tries one write of each kind and appends the outcome of
// each to late-<name>.log: "<write> ok", or "<write> refused <tag of the error>". It writes tool-entered-<name> when it
// starts. A test takes the thread away while the tool waits, so every write after the wait is a stale one.
import fs from "node:fs"
import path from "node:path"
import { defineTool } from "@standardagents/spec"
import { z } from "zod"

export default defineTool({
  description: "Wait until the test releases the named gate, then write to the thread",
  args: z.object({ name: z.string() }),
  execute: async (state, { name }) => {
    const dir = process.env.SPINDLE_GATE_DIR ?? "."
    const first = (await state.getMessages({ order: "asc", limit: 1 })).messages[0]?.id ?? ""
    fs.appendFileSync(path.join(dir, "tool-log"), `${name}\n`)
    fs.writeFileSync(path.join(dir, `tool-entered-${name}`), "")
    while (!fs.existsSync(path.join(dir, `release-${name}`))) await new Promise((resolve) => setTimeout(resolve, 10))
    const writes: Array<[string, () => Promise<unknown>]> = [
      ["setValue", () => state.setValue("late", "1")],
      ["queueMessage", () => state.queueMessage({ role: "user", content: "late-queue" })],
      ["injectMessage", () => state.injectMessage({ role: "user", content: "late-inject" })],
      ["updateMessage", () => state.updateMessage(first, { content: "late-edit" })],
      ["deleteMessage", () => state.deleteMessage(first)],
      ["terminate", () => state.terminate()],
    ]
    for (const [label, write] of writes) {
      let outcome = "ok"
      try {
        await write()
      } catch (error) {
        const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "untyped"
        outcome = `refused ${tag}`
      }
      fs.appendFileSync(path.join(dir, `late-${name}.log`), `${label} ${outcome}\n`)
    }
    return { status: "success", result: `late ${name} returned` }
  },
})
