import type { RuntimeSession } from "../../RuntimeDriver.ts"
import { stubTool } from "../harness.ts"

export const noop = stubTool("Do nothing", "noop")

export const contents = async (session: RuntimeSession, thread: string) =>
  (await session.messages(thread)).map((message) => (message.role === "tool" ? message.tool_status : message.content))

export const all = (names: ReadonlyArray<string>, outcome: string) =>
  Object.fromEntries(names.map((name) => [name, outcome]))
