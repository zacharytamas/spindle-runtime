import { pathToFileURL } from "node:url"

export { openChatTerminal } from "./chat-terminal.ts"
export { onInterrupt, runMain } from "./interrupts.ts"
export { processAlive } from "./process-alive.ts"

export const processId = process.pid

// Node 23 and early Node 24 lack import.meta.main. With --eval, argv[1] is user input, not an entry path.
export const isMain = (meta: ImportMeta): boolean => {
  if (meta.main !== undefined) return meta.main
  const entry = process.argv[1]
  if (entry === undefined || process.execArgv.some((arg) => /^(?:-[ep]|--(?:eval|print)(?:=|$))/.test(arg)))
    return false
  return meta.url === import.meta.resolve(pathToFileURL(entry).href)
}
