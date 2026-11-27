import {
  type AttachmentRef,
  defineHook,
  defineTool,
  type HookToolResult,
  type Message,
  type ProviderStreamChunk,
  type ThreadState,
} from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, ok, runTurn, type Scenario, toolResults, using } from "../harness.ts"

import { hookIds, noop, toolRows } from "./fixtures.ts"

const ref = (id: string): AttachmentRef => ({
  id,
  type: "file",
  path: `/files/${id}.txt`,
  name: `${id}.txt`,
  mimeType: "text/plain",
  size: 4,
})

export const H12: Scenario = {
  name: "H12 runs started and done once per call, the success or the failure branch by outcome, and before-store on both",
  requirements: ["7bef4e87", "295f041d", "6d96f2a3", "baf0fc02", "a91f50b9", "20b781d9", "565d6e35", "ca83d472"],
  run: async (driver) => {
    const run = async (replace: boolean) => {
      const events: Array<unknown> = []
      const received: Array<unknown> = []
      const hooks = [
        defineHook({
          hook: "tool_call_started",
          id: "log_start",
          execute: async (_state, toolCall, progress) => {
            events.push(["start", toolCall.id, toolCall.function.name, progress])
            toolCall.function.name = "hijacked"
            toolCall.function.arguments = "{}"
            return { replaced: true } as unknown as undefined
          },
        }),
        defineHook({
          hook: "after_tool_call_success",
          id: "fix_success",
          execute: async (_state, toolCall, result) => {
            events.push(["success", toolCall.id, result.result])
            return replace ? { ...result, result: "S!" } : null
          },
        }),
        defineHook({
          hook: "after_tool_call_failure",
          id: "fix_failure",
          execute: async (_state, toolCall, result) => {
            events.push(["failure", toolCall.id, result.error])
            return replace ? { ...result, error: "F!" } : null
          },
        }),
        defineHook({
          hook: "before_store_tool_result",
          id: "mark",
          execute: async (_state, toolCall, result) => {
            events.push(["store", toolCall.id, result.status])
            return result.status === "success"
              ? { ...result, result: `${result.result} [m]` }
              : { ...result, error: `${result.error} [m]` }
          },
        }),
        defineHook({
          hook: "prefilter_llm_history",
          id: "pass_through",
          execute: async (_state, messages) => messages,
        }),
        defineHook({
          hook: "tool_call_done",
          id: "log_done",
          execute: async (_state, toolCall, result) => {
            events.push(["done", toolCall.id, result.status, result.result ?? result.error])
            result.result = "mutated"
            return { status: "success", result: "hijack" } as unknown as undefined
          },
        }),
      ]
      const tools = {
        good: defineTool({
          description: "Succeed",
          args: z.object({ q: z.string() }),
          execute: async (_state: ThreadState, args: { q: string }) => {
            received.push(args)
            return ok("good result")
          },
        }),
        bad: defineTool({
          description: "Fail",
          execute: async () => {
            throw new Error("bad error")
          },
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c_good", name: "good", arguments: { q: "x" } },
            { id: "c_bad", name: "bad", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      let stored: ReadonlyArray<Message> = []
      await using(driver, { provider, tools, hooks, prompt: { hooks: hookIds(hooks) } }, async (session, thread) => {
        await session.send(thread, "go")
        stored = await session.messages(thread)
      })
      return { events, received, stored, request: provider.requests[1] }
    }
    const replaced = await run(true)
    expect(replaced.events).toEqual([
      ["start", "c_good", "good", undefined],
      ["start", "c_bad", "bad", undefined],
      ["success", "c_good", "good result"],
      ["store", "c_good", "success"],
      ["done", "c_good", "success", "S! [m]"],
      ["failure", "c_bad", "Tool bad threw: bad error"],
      ["store", "c_bad", "error"],
      ["done", "c_bad", "error", "F! [m]"],
    ])
    expect(replaced.received).toEqual([{ q: "x" }])
    expect(toolRows(replaced.stored)).toEqual([
      ["c_good", "success", "S! [m]"],
      ["c_bad", "error", "F! [m]"],
    ])
    expect(JSON.parse(replaced.stored[1]?.tool_calls ?? "[]")).toEqual([
      { id: "c_good", type: "function", function: { name: "good", arguments: '{"q":"x"}' } },
      { id: "c_bad", type: "function", function: { name: "bad", arguments: "{}" } },
    ])
    expect(history(replaced.request).filter((m) => m.role === "tool")).toEqual([
      { role: "tool", toolCallId: "c_good", toolName: "good", content: "S! [m]" },
      { role: "tool", toolCallId: "c_bad", toolName: "bad", content: { type: "error", error: "F! [m]" } },
    ])
    const kept = await run(false)
    expect(toolRows(kept.stored)).toEqual([
      ["c_good", "success", "good result [m]"],
      ["c_bad", "error", "Tool bad threw: bad error [m]"],
    ])
  },
}

export const H12e: Scenario = {
  name: "H12e keeps the tool's text when a result hook cannot receive an isolated copy",
  requirements: ["5fc8a060"],
  run: async (driver) => {
    let called = false
    const hook = defineHook({
      hook: "before_store_tool_result",
      id: "change_text",
      execute: async (_state, _call, result) => {
        called = true
        result.result = "modified"
        throw new Error("hook failed")
      },
    })
    const tools = {
      diagnostic: defineTool({
        description: "Returns an uncloneable diagnostic",
        execute: async () => ({ status: "error", result: "original", error_data: { callback: () => 0 } }),
      }),
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "diagnostic", arguments: {} }] },
      { text: "done" },
    ])
    await using(
      driver,
      { provider, tools, hooks: [hook], prompt: { hooks: ["change_text"] } },
      async (session, thread) => {
        await session.send(thread, "go")
        const result = (await session.messages(thread)).find((message) => message.tool_call_id === "c1")
        expect(result?.content).toContain("original")
        expect(called).toBe(false)
      },
    )
  },
}

export const H12b: Scenario = {
  name: "H12b calls the success hook only after a tool succeeds and the failure hook only after one fails",
  requirements: ["a91f50b9", "0fc819f0", "ca83d472", "5fc8a060"],
  run: async (driver) => {
    const events: Array<unknown> = []
    const hooks = [
      defineHook({
        hook: "after_tool_call_success",
        id: "on_success",
        execute: async (_state, toolCall) => {
          events.push(["success", toolCall.id, ran.slice()])
          return null
        },
      }),
      defineHook({
        hook: "after_tool_call_failure",
        id: "on_failure",
        execute: async (_state, toolCall) => {
          events.push(["failure", toolCall.id, ran.slice()])
          return null
        },
      }),
      defineHook({
        hook: "before_store_tool_result",
        id: "on_store",
        execute: async (state, toolCall, result) => {
          const rows = (await state.getMessages({ includeSilent: true })).messages
          events.push(["store", toolCall.id, rows.some((m) => m.tool_call_id === toolCall.id)])
          return result
        },
      }),
    ]
    const ran: Array<string> = []
    const tools = {
      fine: defineTool({
        description: "Fine",
        execute: async () => {
          ran.push("fine")
          return ok("fine")
        },
      }),
      refuse: defineTool({
        description: "Return an error",
        execute: async () => {
          ran.push("refuse")
          return { status: "error", error: "refused" }
        },
      }),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "fine", arguments: {} },
          { id: "c2", name: "refuse", arguments: {} },
          { id: "c3", name: "missing", arguments: {} },
        ],
      },
      { text: "done" },
    ])
    await runTurn(driver, { provider, tools, hooks, prompt: { hooks: hookIds(hooks) } }, "go")
    expect(events).toEqual([
      ["success", "c1", ["fine"]],
      ["store", "c1", false],
      ["failure", "c2", ["fine", "refuse"]],
      ["store", "c2", false],
      ["failure", "c3", ["fine", "refuse"]],
      ["store", "c3", false],
    ])
  },
}

export const H12c: Scenario = {
  name: "H12c hands tool_call_done the result as it is stored, after the result hooks, the create hooks, and redaction",
  requirements: ["6d96f2a3", "baf0fc02"],
  run: async (driver) => {
    const done: Array<unknown> = []
    const variables = [{ name: "MARK", type: "secret" as const, required: true, description: "A secret" }]
    const hooks = [
      defineHook({
        hook: "before_store_tool_result",
        id: "store_mark",
        execute: async (_state, _call, result) =>
          result.status === "success"
            ? { ...result, result: `${result.result} [store]` }
            : { ...result, error: `${result.error} [store]` },
      }),
      defineHook({
        hook: "before_create_message",
        id: "create_mark",
        execute: async (_state, message) =>
          message.role === "tool" ? { ...message, content: `${message.content} [create]` } : message,
      }),
      defineHook({
        hook: "tool_call_done",
        id: "record_done",
        execute: async (state, toolCall, result) => {
          const stored = state.execution?.messageHistory.find((m) => m.tool_call_id === toolCall.id)
          done.push([toolCall.id, result.status, result.result ?? result.error, stored?.content])
        },
      }),
    ]
    const tools = {
      reveal: defineTool({
        description: "Return the secret",
        variables,
        execute: async (state: ThreadState) => ok(`value ${await state.env("MARK")}`),
      }),
      refuse: defineTool({
        description: "Return an error",
        execute: async () => ({ status: "error" as const, error: "refused" }),
      }),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "reveal", arguments: {} },
          { id: "c2", name: "refuse", arguments: {} },
        ],
      },
      { text: "done" },
    ])
    await using(
      driver,
      { provider, tools, hooks, prompt: { hooks: hookIds(hooks) } },
      async (session, thread) => {
        await session.send(thread, "go")
      },
      { instanceEnv: { MARK: "hidden-value-58" } },
    )
    expect(done).toEqual([
      ["c1", "success", "value [redacted] [store] [create]", "value [redacted] [store] [create]"],
      ["c2", "error", "refused [store] [create]", "refused [store] [create]"],
    ])
  },
}

export const H12d: Scenario = {
  name: "H12d closes a call that started in a response that then failed with one tool_call_done and runs nothing else for it",
  requirements: ["6d96f2a3"],
  run: async (driver) => {
    const events: Array<unknown> = []
    const hooks = [
      defineHook({
        hook: "tool_call_started",
        id: "on_start",
        execute: async (_state, toolCall) => {
          events.push(["started", toolCall.id])
        },
      }),
      defineHook({
        hook: "after_tool_call_failure",
        id: "on_failure",
        execute: async (_state, toolCall) => {
          events.push(["failure", toolCall.id])
          return null
        },
      }),
      defineHook({
        hook: "tool_call_done",
        id: "on_done",
        execute: async (_state, toolCall, result) => {
          events.push(["done", toolCall.id, result.status, result.error])
        },
      }),
    ]
    const provider = new ScriptedProvider([
      {
        chunks: [
          { type: "tool-call-start", id: "c_lost", name: "noop" },
          { type: "error", error: "upstream dropped", code: "server_error" },
        ],
      },
      { text: "done" },
    ])
    await using(
      driver,
      { provider, tools: noop, hooks, prompt: { hooks: hookIds(hooks) } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 1 })
        expect(toolRows(await session.messages(thread))).toEqual([])
      },
    )
    expect(events).toEqual([
      ["started", "c_lost"],
      ["done", "c_lost", "error", "Spindle did not run this call, because the model response that held it failed."],
    ])
  },
}

export const H13: Scenario = {
  name: "H13 starts a call when it appears, or when its progress argument is complete, or when it finishes without it",
  requirements: ["bdfd2d2d", "7bef4e87", "31e58fe6", "3fb4e4f0", "106ba9d7", "b02bac78", "f31fd3d3", "8f7b59dd"],
  run: async (driver) => {
    const started: Array<[string, string, string, string | undefined]> = []
    const checks: Array<string> = []
    const hooks = [
      defineHook({
        hook: "tool_call_started",
        id: "watch",
        execute: async (_state, toolCall, progress) => {
          started.push([toolCall.id, toolCall.function.name, toolCall.function.arguments, progress])
        },
      }),
    ]
    const tools = {
      plain: defineTool({
        description: "No progress argument",
        args: z.object({ q: z.string() }),
        execute: async () => ok("plain"),
      }),
      writer: defineTool({
        description: "Write a file",
        progressArgument: "description",
        args: z.object({ description: z.string(), content: z.string() }),
        execute: async () => ok("written"),
      }),
    }
    const check = (label: string, holds: () => boolean) => async () => {
      checks.push(`${label}: ${holds()}`)
    }
    const has = (id: string) => () => started.some((entry) => entry[0] === id)
    const chunks: Array<ProviderStreamChunk | (() => Promise<void>)> = [
      { type: "tool-call-start", id: "p1", name: "plain" },
      check("p1 started before its arguments", has("p1")),
      { type: "tool-call-delta", id: "p1", argumentsDelta: '{"q":' },
      { type: "tool-call-delta", id: "p1", argumentsDelta: '"x"}' },
      { type: "tool-call-done", id: "p1", arguments: { q: "x" } },
      { type: "tool-call-start", id: "w1", name: "writer" },
      { type: "tool-call-delta", id: "w1", argumentsDelta: '{"descr' },
      { type: "tool-call-delta", id: "w1", argumentsDelta: 'iption": "fix' },
      check("w1 not started inside its progress argument", () => !has("w1")()),
      { type: "tool-call-delta", id: "w1", argumentsDelta: 'ing \\"index.html\\""' },
      { type: "tool-call-delta", id: "w1", argumentsDelta: ', "content": "' },
      check("w1 started before the rest of the call", has("w1")),
      { type: "tool-call-delta", id: "w1", argumentsDelta: 'a long body"}' },
      { type: "tool-call-done", id: "w1", arguments: { description: 'fixing "index.html"', content: "a long body" } },
      { type: "tool-call-start", id: "w2", name: "writer" },
      { type: "tool-call-delta", id: "w2", argumentsDelta: '{"content": "no description"}' },
      check("w2 not started before it is done", () => !has("w2")()),
      { type: "tool-call-done", id: "w2", arguments: { content: "no description" } },
      check("w2 started once it is done", has("w2")),
      { type: "finish", finishReason: "tool_calls", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
    ]
    const provider = new ScriptedProvider([{ chunks }, { text: "done" }])
    await runTurn(driver, { provider, tools, hooks, prompt: { hooks: ["watch"] } }, "go")
    expect(checks).toEqual([
      "p1 started before its arguments: true",
      "w1 not started inside its progress argument: true",
      "w1 started before the rest of the call: true",
      "w2 not started before it is done: true",
      "w2 started once it is done: true",
    ])
    expect(started).toEqual([
      ["p1", "plain", "", undefined],
      ["w1", "writer", '{"description": "fixing \\"index.html\\""', 'fixing "index.html"'],
      ["w2", "writer", '{"content": "no description"}', undefined],
    ])
  },
}

export const H14: Scenario = {
  name: "H14 lets the result hooks keep, replace, or add attachment references and stores the references they return",
  requirements: ["8e371f2b", "5fc8a060"],
  run: async (driver) => {
    const seen: Array<unknown> = []
    const hooks = [
      defineHook({
        hook: "after_tool_call_success",
        id: "rewrite_text",
        execute: async (_state, _call, result) => ({ ...result, result: `rewritten ${result.result}` }),
      }),
      defineHook({
        hook: "after_tool_call_failure",
        id: "recover",
        execute: async (_state, toolCall, result): Promise<HookToolResult> =>
          toolCall.function.name === "broken"
            ? { status: "error", error: "recovered", attachments: [ref("from_failure")] }
            : result,
      }),
      defineHook({
        hook: "before_store_tool_result",
        id: "swap_ref",
        execute: async (_state, toolCall, result) => {
          seen.push([toolCall.id, result.result ?? result.error, result.attachments])
          return toolCall.id === "c_files" ? { ...result, attachments: [ref("replacement")] } : result
        },
      }),
    ]
    const fresh = { name: "new.png", mimeType: "image/png", data: "iVBORw0KGgo=" }
    const tools = {
      files: defineTool({
        description: "Return a file",
        execute: async () => ({ status: "success" as const, result: "two files", attachments: [ref("original")] }),
      }),
      broken: defineTool({
        description: "Throw",
        execute: async () => {
          throw new Error("broken")
        },
      }),
      make: defineTool({
        description: "Return a new file",
        execute: async () => ({ status: "success" as const, result: "made", attachments: [fresh] }),
      }),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c_files", name: "files", arguments: {} },
          { id: "c_broken", name: "broken", arguments: {} },
          { id: "c_make", name: "make", arguments: {} },
        ],
      },
      { text: "done" },
    ])
    let stored: ReadonlyArray<Message> = []
    await using(driver, { provider, tools, hooks, prompt: { hooks: hookIds(hooks) } }, async (session, thread) => {
      await session.send(thread, "go")
      stored = await session.messages(thread)
    })
    expect(seen).toEqual([
      ["c_files", "rewritten two files", [ref("original")]],
      ["c_broken", "recovered", [ref("from_failure")]],
      ["c_make", "rewritten made", [fresh]],
    ])
    const rows = toolResults(stored)
    expect(rows.map((m) => [m.tool_call_id, m.content, m.attachments])).toEqual([
      ["c_files", "rewritten two files", [ref("replacement")]],
      ["c_broken", "recovered", [ref("from_failure")]],
      [
        "c_make",
        "rewritten made\n\nSpindle dropped the new file new.png, because this version cannot store a new file. The thread file system arrives in M3.",
        null,
      ],
    ])
  },
}
