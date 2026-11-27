import { defineHook, defineTool } from "@standardagents/spec"
import { expect, it } from "vitest"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { runTurn, using } from "../../../conformance/src/scenarios/harness.ts"
import { spindleDriver } from "../spindle-driver.ts"

it("gives create hooks the original unstorable draft and the replacement only if insertion fails", async () => {
  const attempts: Array<[string | null | undefined, string | null | undefined]> = []
  const repair = defineHook({
    id: "repair",
    hook: "before_create_message",
    execute: async (_state, message) => {
      if (message.role === "tool") {
        attempts.push([message.tool_call_id, message.tool_status])
        if (message.tool_call_id === "repairable") return { ...message, metadata: {} }
      }
      return message
    },
  })
  const tool = defineTool({
    description: "Returns unstorable diagnostic data",
    execute: async () => ({ status: "success" as const, result: "usable", error_data: { count: 1n } }),
  })
  const provider = new ScriptedProvider([
    { toolCalls: ["repairable", "fallback"].map((id) => ({ id, name: "diagnostic", arguments: {} })) },
    { text: "done" },
  ])
  const setup = { provider, tools: { diagnostic: tool }, hooks: [repair], prompt: { hooks: ["repair"] } }
  const stored = await using(spindleDriver, setup, async (session, thread) => {
    await session.send(thread, "go")
    return (await session.messages(thread)).filter((message) => message.role === "tool")
  })
  expect(attempts).toEqual([
    ["repairable", "success"],
    ["fallback", "success"],
    ["fallback", "error"],
  ])
  expect(stored.map((m) => [m.tool_call_id, m.tool_status])).toEqual([
    ["repairable", "success"],
    ["fallback", "error"],
  ])
  expect(stored[0]?.content).toBe("usable")
  expect(stored[1]?.content).toContain("a BigInt at $.error_data.count")
})

it("gives the next create hook the last good id when the proposed id already holds a secret", async () => {
  const token = "secret-id-token"
  const generated: string[] = []
  const seen: string[] = []
  const hooks = [
    defineHook({
      hook: "before_create_message",
      id: "choose",
      execute: async (state, message) => {
        generated.push(message.id)
        await state.instanceEnv?.("TOKEN")
        return { ...message, id: token }
      },
    }),
    defineHook({
      hook: "before_create_message",
      id: "replace",
      execute: async (_state, message) => {
        seen.push(message.id)
        return { ...message, id: "safe-id" }
      },
    }),
  ]
  const setup = { provider: new ScriptedProvider([{ text: "reply" }]), hooks, prompt: { hooks: ["choose", "replace"] } }
  await using(
    spindleDriver,
    setup,
    async (session, thread) => {
      await session.send(thread, "go")
      expect((await session.messages(thread)).at(-1)?.id).toBe("safe-id")
    },
    { instanceEnv: { TOKEN: token } },
  )
  expect(generated).toHaveLength(1)
  expect(seen).toEqual(generated)
})

it("preserves the result's error code when the same literal is redacted from its error text", async () => {
  const code = "E_ACCOUNT"
  const diagnostic = defineTool({
    description: "Returns a known identifier in both fields",
    execute: async (state) => {
      await state.instanceEnv?.("TOKEN")
      return { status: "error" as const, error: code, error_code: code }
    },
  })
  const provider = new ScriptedProvider([
    { toolCalls: [{ id: "c", name: "diagnostic", arguments: {} }] },
    { text: "done" },
  ])
  await using(
    spindleDriver,
    { provider, tools: { diagnostic } },
    async (session, thread) => {
      await session.send(thread, "go")
      expect((await session.messages(thread)).find((m) => m.role === "tool")).toMatchObject({
        content: "[redacted]",
        metadata: { error_code: code },
      })
    },
    { instanceEnv: { TOKEN: code } },
  )
})

it("isolates an after-create observer's edits from the next observer", async () => {
  const seen: Array<string | null> = []
  const edit = defineHook({
    hook: "after_create_message",
    id: "edit",
    execute: async (_state, message) => {
      message.content = "private edit"
      throw new Error("observer failed")
    },
  })
  const read = defineHook({
    hook: "after_create_message",
    id: "read",
    execute: async (_state, message) => {
      seen.push(message.content)
    },
  })
  await runTurn(
    spindleDriver,
    { provider: new ScriptedProvider([{ text: "reply" }]), hooks: [edit, read], prompt: { hooks: ["edit", "read"] } },
    "go",
  )
  expect(seen).toEqual(["reply"])
})

it("runs a repeated hook definition once at its first position in the list", async () => {
  const seen: string[] = []
  const hooks = ["first", "second"].map((id) =>
    defineHook({
      hook: "after_create_message",
      id,
      execute: async () => {
        seen.push(id)
      },
    }),
  )
  await runTurn(
    spindleDriver,
    { provider: new ScriptedProvider([{ text: "reply" }]), hooks, prompt: { hooks: ["first", "second", "first"] } },
    "go",
  )
  expect(seen).toEqual(["first", "second"])
})
