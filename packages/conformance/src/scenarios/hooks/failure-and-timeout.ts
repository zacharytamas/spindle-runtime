import { defineHook, defineTool, type Message, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, ok, type Scenario, type Setup, sideOf, using } from "../harness.ts"

import { hookIds, noop, toolRows } from "./fixtures.ts"

export const H15: Scenario = {
  name: "H15 goes on without a hook that does not settle in time and logs only its id, never its error text",
  requirements: ["cb48415f", "3d8dede1"],
  run: async (driver) => {
    const later: Array<string> = []
    const hooks = [
      defineHook({
        hook: "filter_messages",
        id: "stuck_filter",
        execute: () => new Promise<Array<Message>>(() => {}),
      }),
      defineHook({ hook: "tool_call_done", id: "stuck_done", execute: () => new Promise<void>(() => {}) }),
      defineHook({
        hook: "after_tool_call_success",
        id: "leaky",
        execute: async () => {
          throw new Error("failed with SENTINEL_7731 inside")
        },
      }),
      defineHook({
        hook: "after_create_message",
        id: "after_stuck",
        execute: async (_state, message) => {
          later.push(message.role)
        },
      }),
    ]
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
      { text: "done" },
    ])

    await using(
      driver,
      { provider, tools: noop, hooks, prompt: { hooks: hookIds(hooks) } },
      async (loaded, thread) => {
        const started = Date.now()
        const outcome = await loaded.send(thread, "go")
        const elapsed = Date.now() - started
        expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
        expect(elapsed).toBeLessThan(5000)
        expect(provider.requests).toHaveLength(2)
        expect(history(provider.requests[0]).map(sideOf)).toEqual([["user", "go"]])
        const stored = await loaded.messages(thread)
        expect(toolRows(stored)).toEqual([["c1", "success", "noop"]])
        expect(later).toEqual(["assistant", "tool", "assistant"])
        const logs = loaded.logs().join("\n")
        expect(logs).toContain("Hook stuck_filter (filter_messages")
        expect(logs).toContain("Hook stuck_done (tool_call_done")
        expect(logs).toContain("Its ThreadState refuses every later call")
        expect(logs).toContain("Hook leaky (after_tool_call_success")
        expect(logs).not.toContain("SENTINEL_7731")
        expect(logs).not.toContain("noop")
        expect(JSON.stringify(outcome)).not.toContain("SENTINEL_7731")
      },
      {
        hookTimeoutMs: 150,
      },
    )
  },
}

export const H15b: Scenario = {
  name: "H15b discards a return that comes after the time limit and refuses later calls from that hook's state",
  requirements: ["cb48415f", "3d8dede1"],
  run: async (driver) => {
    let late: (outcome: string) => void = () => {}
    const lateCall = new Promise<string>((resolve) => {
      late = resolve
    })
    let blocked = false
    let waited = false
    const hooks = [
      defineHook({
        hook: "after_system_message",
        id: "busy",
        execute: () => {
          if (blocked) return null
          blocked = true
          const until = Date.now() + 400
          while (Date.now() < until) {}
          return "OVERTIME"
        },
      }),
      defineHook({
        hook: "filter_messages",
        id: "slow_writer",
        execute: async (state, messages) => {
          if (waited) return messages
          waited = true
          await new Promise((resolve) => setTimeout(resolve, 400))
          late(
            await state.injectMessage({ role: "user", content: "too late" }).then(
              () => "stored",
              (error: Error) => `${error.name}: ${error.message}`,
            ),
          )
          return [...messages, { id: "late", role: "user", content: "late filter", created_at: 0 } as Message]
        },
      }),
    ]
    const provider = new ScriptedProvider([{ text: "done" }, { text: "again" }])

    await using(
      driver,
      { provider, hooks, prompt: { hooks: hookIds(hooks), includeChat: true } },
      async (loaded, thread) => {
        expect(await loaded.send(thread, "go")).toMatchObject({ status: "idle", steps: 1 })
        expect(await lateCall).toMatch(/^HookExpired: Hook slow_writer \(filter_messages\) ran past its time limit/)
        await loaded.send(thread, "next")
        expect(provider.requests.map((request) => request.messages[0]?.content)).toEqual([
          "You are a test assistant.",
          "You are a test assistant.",
        ])
        expect(provider.requests.map((request) => history(request).map(sideOf))).toEqual([
          [["user", "go"]],
          [
            ["user", "go"],
            ["assistant", "done", []],
            ["user", "next"],
          ],
        ])
        expect((await loaded.messages(thread)).map((m) => m.content)).toEqual(["go", "done", "next", "again"])
        const logs = loaded.logs().join("\n")
        expect(logs).toContain("Hook busy (after_system_message")
        expect(logs).toContain("Hook slow_writer (filter_messages")
      },
      {
        hookTimeoutMs: 150,
      },
    )
  },
}

export const H15c: Scenario = {
  name: "H15c refuses a write nested deeper than the limit and names the hook that made it",
  requirements: ["3d8dede1"],
  run: async (driver) => {
    const refused: Array<string> = []
    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "recurse",
        execute: async (state, message) => {
          const depth = message.content === "start" ? 0 : Number(message.content?.match(/^nested (\d+)$/)?.[1] ?? 12)
          if (depth < 12)
            await state.injectMessage({ role: "user", content: `nested ${depth + 1}` }).catch((error: Error) => {
              refused.push(`${error.name}: ${error.message}`)
            })
          return message
        },
      }),
    ]
    const tools = {
      start: defineTool({
        description: "Inject the first message",
        execute: async (state: ThreadState) => {
          await state.injectMessage({ role: "user", content: "start" })
          return ok("started")
        },
      }),
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "start", arguments: {} }] },
      { text: "done" },
    ])
    await using(driver, { provider, tools, hooks, prompt: { hooks: ["recurse"] } }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
      const nested = (await session.messages(thread)).flatMap((m) =>
        m.content?.startsWith("nested") ? [m.content] : [],
      )
      expect(nested.sort()).toEqual([
        "nested 1",
        "nested 2",
        "nested 3",
        "nested 4",
        "nested 5",
        "nested 6",
        "nested 7",
        "nested 8",
      ])
    })
    expect(refused).toEqual([
      "NestedWriteTooDeep: Hook recurse (before_create_message) made a write 9 hook writes deep, past the limit of 8, so Spindle refused it",
    ])
  },
}

export const H16: Scenario = {
  name: "H16 finishes a turn whose observing hooks and result transformer throw and stores the original result",
  requirements: ["732b2d4b", "3d8dede1", "41bdae5c", "4029d475"],
  run: async (driver) => {
    const ran: Array<string> = []
    const boom = (id: string) => async () => {
      throw new Error(`${id} broke`)
    }
    const hooks = [
      defineHook({ hook: "after_thread_created", id: "boom_created", execute: boom("created") }),
      defineHook({ hook: "tool_call_started", id: "boom_started", execute: boom("started") }),
      defineHook({ hook: "tool_call_done", id: "boom_done", execute: boom("done") }),
      defineHook({ hook: "before_store_tool_result", id: "boom_store", execute: boom("store") }),
    ]
    const tools = {
      count: defineTool({
        description: "Count runs",
        execute: async () => {
          ran.push("count")
          return ok("counted")
        },
      }),
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "count", arguments: {} }] },
      { text: "done" },
    ])
    await using(driver, { provider, tools, hooks, agent: { hooks: hookIds(hooks) } }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
      expect(ran).toEqual(["count"])
      const stored = await session.messages(thread)
      expect(stored.map((m) => [m.role, m.content])).toEqual([
        ["user", "go"],
        ["assistant", null],
        ["tool", "counted"],
        ["assistant", "done"],
      ])
      expect(toolRows(stored)).toEqual([["c1", "success", "counted"]])
      const logs = session.logs().join("\n")
      for (const id of ["boom_created", "boom_started", "boom_done", "boom_store"]) expect(logs).toContain(`Hook ${id}`)
    })
  },
}

export const H23: Scenario = {
  name: "H23 counts a return that does not fit the hook's type as a failure of that hook and finishes the turn",
  requirements: ["3d8dede1"],
  run: async (driver) => {
    const runWith = async (hook: NonNullable<Setup["hooks"]>[number]) => {
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
        { text: "done" },
      ])
      let outcome: unknown
      let stored: ReadonlyArray<Message> = []
      let logs = ""
      await using(
        driver,
        { provider, tools: noop, hooks: [hook], prompt: { hooks: [hook.id] } },
        async (session, thread) => {
          outcome = await session.send(thread, "go")
          stored = await session.messages(thread)
          logs = session.logs().join("\n")
        },
      )
      return { outcome, stored, logs, requests: provider.requests.map((request) => history(request).map(sideOf)) }
    }
    const kept = [
      [["user", "go"]],
      [
        ["user", "go"],
        ["assistant", null, ["c1"]],
        ["tool", "c1"],
      ],
    ]
    const filterReturning = (extra: Record<string, unknown>) =>
      defineHook({
        hook: "filter_messages",
        id: "odd_filter",
        execute: async (_state, messages) => [...messages, { id: "odd", created_at: 0, ...extra } as Message],
      })
    for (const extra of [
      { role: "user", content: { text: "an object" } },
      { role: "user" },
      { role: "user", content: "x", attachments: { id: "not a list" } },
      { role: "user", content: "x", attachments: [{ id: "a", type: "file" }] },
    ]) {
      const result = await runWith(filterReturning(extra))
      expect(result.outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
      expect(result.requests).toEqual(kept)
      expect(result.logs).toContain("Hook odd_filter (filter_messages")
    }
    const guarded = await runWith(
      defineHook({
        hook: "filter_messages",
        id: "odd_filter",
        execute: async (_state, messages) => [
          ...messages,
          Object.defineProperty({ id: "odd", role: "user", created_at: 0 }, "content", {
            enumerable: true,
            get: () => {
              throw new Error("accessor")
            },
          }) as Message,
        ],
      }),
    )
    expect(guarded.outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
    expect(guarded.requests).toEqual(kept)
    expect(guarded.logs).toContain("Hook odd_filter (filter_messages")
    expect(guarded.logs).not.toContain("accessor")
    const createReturning = (change: (message: Message) => Message) =>
      defineHook({
        hook: "before_create_message",
        id: "odd_create",
        execute: async (_state, message) => (message.role === "tool" ? change(message) : message),
      })
    for (const change of [
      (message: Message) =>
        Object.defineProperty({ ...message, content: "changed" }, "metadata", {
          enumerable: true,
          get: () => {
            throw new Error("accessor")
          },
        }) as Message,
      (message: Message) => ({ ...message, content: "changed", attachments: [null] as unknown as [] }),
      (message: Message) => ({ ...message, content: "changed", metadata: { when: new Date(0) } }),
    ]) {
      const result = await runWith(createReturning(change))
      expect(result.outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
      expect(toolRows(result.stored)).toEqual([["c1", "success", "noop"]])
      expect(result.requests).toEqual(kept)
      expect(result.logs).toContain("Hook odd_create (before_create_message")
      expect(result.logs).not.toContain("accessor")
    }
  },
}

export const H23b: Scenario = {
  name: "H23b fails a before_create_message hook that changes a message's role or a tool result's call id",
  requirements: ["3d8dede1"],
  run: async (driver) => {
    const outcomes: Array<unknown> = []
    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "reidentify",
        execute: async (_state, message) => {
          if (message.content === "to system") return { ...message, role: "system" }
          if (message.tool_call_id === "c1") return { ...message, tool_call_id: "orphan", content: "moved" }
          if (message.tool_call_id === "c2") return { ...message, role: "assistant", content: "recast" }
          return message
        },
      }),
    ]
    const tools = {
      inject: defineTool({
        description: "Inject a user message",
        execute: async (state: ThreadState) => {
          outcomes.push(
            await state.injectMessage({ role: "user", content: "to system" }).then(
              (message) => message.role,
              (error: Error) => error.message,
            ),
          )
          return ok("injected")
        },
      }),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c1", name: "noop", arguments: {} },
          { id: "c2", name: "inject", arguments: {} },
        ],
      },
      { text: "done" },
    ])
    await using(
      driver,
      { provider, tools: { ...noop, ...tools }, hooks, prompt: { hooks: ["reidentify"] } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const stored = await session.messages(thread)
        expect(stored.map((m) => [m.role, m.tool_call_id, m.content])).toEqual([
          ["user", null, "go"],
          ["assistant", null, null],
          ["tool", "c1", "noop"],
          ["tool", "c2", "injected"],
          ["assistant", null, "done"],
        ])
        expect(history(provider.requests[1]).map(sideOf)).toEqual([
          ["user", "go"],
          ["assistant", null, ["c1", "c2"]],
          ["tool", "c1"],
          ["tool", "c2"],
        ])
      },
    )
    expect(outcomes).toEqual([
      "Hook reidentify (before_create_message) returned a value that is not a message the store can hold, with the role, the tool calls, and the call id it was given, so Spindle did not make the change",
    ])
  },
}
