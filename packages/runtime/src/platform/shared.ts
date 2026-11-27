import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

export { openChatTerminal } from "./chat-terminal.ts"
export { Interrupts, runMain } from "./interrupts.ts"
export { processAlive } from "./process-alive.ts"

export const processId = process.pid

// Node 23 and early Node 24 lack import.meta.main. With --eval, argv[1] is user input, not an entry path.
export const isMain = (meta: ImportMeta): boolean => {
  if (meta.main !== undefined) return meta.main
  const entry = process.argv[1]
  if (entry === undefined || process.execArgv.some((arg) => /^(?:-[ep]|--(?:eval|print)(?:=|$))/.test(arg)))
    return false
  try {
    const url = new URL(meta.url)
    return !url.search && !url.hash && realpathSync(fileURLToPath(url)) === realpathSync(entry)
  } catch {
    return false
  }
}
