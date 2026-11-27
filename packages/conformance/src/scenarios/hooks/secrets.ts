import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { holding, ok, type Scenario, using } from "../harness.ts"

import { hookIds, noop } from "./fixtures.ts"

export const H22: Scenario = {
  name: "H22 redacts the text a hook writes into the thread and fails a run whose system prompt a hook gives a secret",
  requirements: ["d263e879", "287f2aef"],
  run: async (driver) => {
    const marker = "HOOK-SECRET-51c"
    const variables = [{ name: "MARK", type: "secret" as const, required: true, description: "A secret" }]
    let injected = false
    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "tag_reply",
        execute: async (state, message) =>
          message.content === "reply"
            ? { ...message, content: `reply ${await state.env("MARK")}`, metadata: { by: await state.env("MARK") } }
            : message,
      }),
      defineHook({
        hook: "filter_messages",
        id: "note_secret",
        execute: async (state, messages) => {
          if (!injected) {
            injected = true
            const mark = await state.env("MARK")
            await state.injectMessage({ role: "user", content: `filter ${mark}`, metadata: { m: mark } })
          }
          return messages
        },
      }),
      defineHook({
        hook: "before_update_message",
        id: "secret_patch",
        execute: async (state, _id, updates) => ({
          ...updates,
          content: `${updates.content} ${await state.env("MARK")}`,
        }),
      }),
      defineHook({
        hook: "before_store_tool_result",
        id: "stamp_result",
        execute: async (state, _call, result) => ({
          ...result,
          result: `${result.result} ${await state.env("MARK")}`,
        }),
      }),
    ]
    const tools = {
      edit: defineTool({
        description: "Edit the injected note",
        execute: async (state: ThreadState) => {
          const note = state.execution?.messageHistory.find((m) => m.content?.startsWith("filter"))
          await state.updateMessage(note?.id ?? "", { content: "edited" })
          return ok("edited")
        },
      }),
    }
    const provider = new ScriptedProvider([
      { text: "reply", toolCalls: [{ id: "c1", name: "edit", arguments: {} }] },
      { text: `done ${marker}` },
    ])
    await using(
      driver,
      { provider, tools, hooks, prompt: { variables, hooks: hookIds(hooks) } },
      async (session, thread) => {
        await session.send(thread, `hello ${marker}`)
        const stored = await session.messages(thread)
        expect(stored.map((m) => [m.role, m.content])).toEqual([
          ["user", `hello ${marker}`],
          ["user", "edited [redacted]"],
          ["assistant", "reply [redacted]"],
          ["tool", "edited [redacted]"],
          ["assistant", `done ${marker}`],
        ])
        expect(stored[1]?.metadata).toEqual({ m: "[redacted]" })
        expect(stored[2]?.metadata).toEqual({ by: "[redacted]" })
      },
      { instanceEnv: { MARK: marker } },
    )
    const leak = defineHook({
      hook: "after_system_message",
      id: "leak_system",
      execute: async (state, system) => `${system} ${await state.env("MARK")}`,
    })
    const never = new ScriptedProvider([{ text: "never" }])
    await using(
      driver,
      { provider: never, hooks: [leak], prompt: { variables, hooks: ["leak_system"] } },
      async (session, thread) => {
        const outcome = await session.send(thread, "go")
        expect(outcome).toMatchObject({ status: "failed", reason: "fatal_error" })
        expect(outcome.error?.message).toMatch(/holds a secret value/)
        expect(JSON.stringify(outcome)).not.toContain(marker)
      },
      { instanceEnv: { MARK: marker } },
    )
    expect(never.requests).toHaveLength(0)
  },
}

export const H22b: Scenario = {
  name: "H22b redacts a write with the secrets that its hooks learned before the write was stored",
  requirements: ["d263e879", "287f2aef"],
  run: async (driver) => {
    const instance = { LATE_A: "late-injected-71", LATE_B: "late-edited-72", LATE_C: "late-result-73" }
    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "learn_on_create",
        execute: async (state, message) => {
          if (message.content?.startsWith("note")) await state.env("LATE_A")
          if (message.role === "tool") await state.env("LATE_C")
          return message
        },
      }),
      defineHook({
        hook: "before_update_message",
        id: "learn_on_update",
        execute: async (state, _id, updates) => {
          await state.env("LATE_B")
          return updates
        },
      }),
    ]
    const tools = {
      write: defineTool({
        description: "Writes three values it does not know are secret",
        execute: async (state: ThreadState) => {
          await state.injectMessage({ role: "user", content: `note ${instance.LATE_A}` })
          const blank = await state.injectMessage({ role: "user", content: "blank" })
          await state.updateMessage(blank.id, { content: `edit ${instance.LATE_B}` })
          return ok(`result ${instance.LATE_C}`)
        },
      }),
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "write", arguments: {} }] },
      { text: "done" },
    ])
    await using(
      driver,
      { provider, tools, hooks, prompt: { hooks: hookIds(hooks) } },
      async (session, thread) => {
        await session.send(thread, "go")
        const stored = await session.messages(thread)
        expect(stored.map((m) => m.content)).toEqual([
          "go",
          null,
          "note [redacted]",
          "edit [redacted]",
          "result [redacted]",
          "done",
        ])
      },
      { instanceEnv: instance },
    )
    for (const secret of Object.values(instance)) expect(holding(provider.requests, secret)).toEqual([])
  },
}

export const H22c: Scenario = {
  name: "H22c checks hook-chosen ids against values learned later in the same write",
  requirements: ["d263e879"],
  run: async (driver) => {
    const instance = { OPTIONAL: "fixture-optional", REQUIRED: "fixture-required" }
    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "choose_id",
        execute: async (_state, message) => {
          if (message.content === "note") return { ...message, id: instance.OPTIONAL }
          if (message.content === "done") return { ...message, id: instance.REQUIRED }
          return message
        },
      }),
      defineHook({
        hook: "before_create_message",
        id: "learn_value",
        execute: async (state, message) => {
          if (message.content === "note") await state.env("OPTIONAL")
          if (message.content === "done") await state.env("REQUIRED")
          return message
        },
      }),
    ]
    let refusal = ""
    const tools = {
      note: defineTool({
        description: "Inject a note",
        execute: async (state: ThreadState) => {
          await state.injectMessage({ role: "user", content: "note" }).catch((error: Error) => {
            refusal = error.message
          })
          return ok("attempted")
        },
      }),
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "note", arguments: {} }] },
      { text: "done" },
    ])
    await using(
      driver,
      { provider, tools, hooks, prompt: { hooks: hookIds(hooks) } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle" })
        const rows = await session.messages(thread)
        expect(rows.at(-1)?.content).toBe("done")
        expect(rows.at(-1)?.id).not.toContain(instance.REQUIRED)
        expect(rows.some((row) => row.content === "note")).toBe(false)
        expect(refusal).toContain("choose_id")
        for (const value of Object.values(instance))
          expect([refusal, ...session.logs()].join("\n")).not.toContain(value)
      },
      { instanceEnv: instance },
    )
  },
}

export const H22d: Scenario = {
  name: "H22d checks the leading system prompt after the history hooks finish",
  requirements: ["287f2aef"],
  run: async (driver) => {
    const marker = "fixture-late-system"
    const hook = defineHook({
      hook: "prefilter_llm_history",
      id: "learn_during_history",
      execute: async (state, history) => {
        await state.env("LATE")
        return history
      },
    })
    const provider = new ScriptedProvider([{ text: "unused" }])
    await using(
      driver,
      { provider, tools: noop, hooks: [hook], prompt: { prompt: marker, hooks: [hook.id] } },
      async (session, thread) => {
        const outcome = await session.send(thread, "go")
        expect(provider.requests).toHaveLength(0)
        expect(outcome).toMatchObject({
          status: "failed",
          reason: "fatal_error",
          error: {
            message:
              "The system prompt that prompt assistant renders holds a secret value. A system prompt never holds a secret.",
          },
        })
      },
      { instanceEnv: { LATE: marker } },
    )
  },
}
