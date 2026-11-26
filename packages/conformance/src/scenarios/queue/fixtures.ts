import { type AttachmentRef, defineTool } from "@standardagents/spec"
import { z } from "zod"
import type { RecordedRequest } from "../../ScriptedProvider.ts"
import { history, ok, stubTool } from "../harness.ts"

export const echo = defineTool({
  description: "Return the text it is given",
  args: z.object({ text: z.string() }),
  execute: async (_state, { text }) => ok(text),
})

export const noop = stubTool("Do nothing", "noop")

// A response whose text names the user messages that the request ends with, so that a request shows what it held.
export const acknowledge = (request: RecordedRequest) => {
  const trailing: Array<string> = []
  const messages = history(request)
  for (let index = messages.length - 1; index >= 0 && messages[index]?.role === "user"; index--)
    trailing.unshift(String(messages[index]?.content))
  return { text: `ack: ${trailing.join(" | ")}` }
}

export const ref: AttachmentRef = {
  id: "file-1",
  type: "file",
  path: "/notes/a.txt",
  name: "a.txt",
  mimeType: "text/plain",
  size: 4,
}
