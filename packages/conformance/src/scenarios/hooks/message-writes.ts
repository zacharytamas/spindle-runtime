import { defineHook, defineTool, type Message, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, ok, rolesFor, type Scenario, SIDES, using } from "../harness.ts"

import { hookIds, noop } from "./fixtures.ts"

export const H9: Scenario = {
  name: "H9 hands every create hook the full stored record and every update hook the id and the patch, at rest and in a run",
  requirements: ["f6fb47da", "e73207b8", "41d77a88", "b89bae84", "d44aaea6", "91bb4c62", "c6b52c77", "a6fba031"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human, model } = rolesFor(humanOn)
      const before: Array<Message> = []
      const beforeReads: Array<unknown> = []
      const after: Array<unknown> = []
      const updates: Array<unknown> = []
      const seen: Array<unknown> = []
      let filterInjected = false
      const hooks = [
        defineHook({
          hook: "before_create_message",
          id: "stamp",
          execute: async (state, message) => {
            before.push(message)
            beforeReads.push(await state.getMessage(message.id))
            return { ...message, metadata: { ...message.metadata, stamp: `s-${message.content}` } }
          },
        }),
        defineHook({
          hook: "after_create_message",
          id: "readback",
          execute: async (state, message) => {
            after.push([structuredClone(message), await state.getMessage(message.id)])
            message.content = "changed by an after hook"
            return { ...message, content: "returned by an after hook" } as unknown as undefined
          },
        }),
        defineHook({
          hook: "before_update_message",
          id: "patch",
          execute: async (state, messageId, patch) => {
            updates.push([
              "before",
              messageId,
              patch,
              state.execution === null,
              (await state.getMessage(messageId))?.content,
            ])
            return { ...patch, metadata: { ...(patch.metadata as object), reviewed: true } }
          },
        }),
        defineHook({
          hook: "after_update_message",
          id: "updated",
          execute: async (state, message) => {
            updates.push(["after", message, await state.getMessage(message.id)])
          },
        }),
        defineHook({
          hook: "filter_messages",
          id: "hook_inject",
          execute: async (state, messages) => {
            if (!filterInjected) {
              filterInjected = true
              await state.injectMessage({ role: "system", content: "from a hook" })
            }
            return messages
          },
        }),
      ]
      const tools = {
        work: defineTool({
          description: "Write messages",
          execute: async (state: ThreadState) => {
            const call = state.execution?.messageHistory.findLast((m) => m.tool_calls != null)
            seen.push((await state.getMessage(call?.id ?? ""))?.tool_calls != null)
            for (const role of ["user", "assistant", "system"] as const)
              await state.injectMessage({ role, content: `${role} from a tool` })
            const quiet = (await state.getMessages({ includeSilent: true, order: "asc" })).messages[0]
            await state.updateMessage(quiet?.id ?? "", { content: "edited by a tool", metadata: { by: "tool" } })
            return ok("worked")
          },
        }),
        fail: defineTool({
          description: "Fail",
          execute: async () => {
            throw new Error("tool broke")
          },
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c_work", name: "work", arguments: {} },
            { id: "c_fail", name: "fail", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      await using(
        driver,
        { provider, tools, hooks, humanOn, agent: { hooks: hookIds(hooks) } },
        async (session, thread) => {
          await session.seed(thread, [{ role: human, content: "old", silent: true, metadata: { orig: "x" } }])
          await session.send(thread, "go")
          const state = await session.state(thread)
          const quiet = (await session.messages(thread))[0]
          await state.updateMessage(quiet?.id ?? "", { content: "edited at rest", metadata: { by: "rest" } })
          const stored = await session.messages(thread)
          const created = stored.slice(1)
          expect(created.map((m) => [m.role, m.content])).toEqual([
            [human, "go"],
            ["system", "from a hook"],
            [model, null],
            ["user", "user from a tool"],
            ["assistant", "assistant from a tool"],
            ["system", "system from a tool"],
            ["tool", "worked"],
            ["tool", "Tool fail threw: tool broke"],
            [model, "done"],
          ])
          expect(before.map((m) => [m.id, m.created_at, m.content])).toEqual(
            created.map((m) => [m.id, m.created_at, m.content]),
          )
          for (const message of created) expect(message.metadata?.stamp).toBe(`s-${message.content}`)
          expect(beforeReads).toEqual(created.map(() => null))
          expect(updates).toHaveLength(4)
          expect(after).toEqual(created.map((message) => [message, message]))
          expect(seen).toEqual([true])
          const [first, second] = [updates.slice(0, 2), updates.slice(2, 4)]
          expect(first[0]).toEqual([
            "before",
            quiet?.id,
            { content: "edited by a tool", metadata: { by: "tool" } },
            false,
            "old",
          ])
          expect(second[0]).toEqual([
            "before",
            quiet?.id,
            { content: "edited at rest", metadata: { by: "rest" } },
            true,
            "edited by a tool",
          ])
          expect(stored[0]).toMatchObject({
            content: "edited at rest",
            silent: true,
            metadata: { orig: "x", by: "rest", reviewed: true },
          })
          expect(second[1]).toEqual(["after", stored[0], stored[0]])
          expect(first[1]).toEqual([
            "after",
            { ...stored[0], content: "edited by a tool", metadata: { orig: "x", by: "tool", reviewed: true } },
            { ...stored[0], content: "edited by a tool", metadata: { orig: "x", by: "tool", reviewed: true } },
          ])
        },
      )
    }
  },
}

export const H9b: Scenario = {
  name: "H9b stores a hook's own id, time, and JSON metadata text, and refuses an id another message holds or an update key it adds",
  requirements: ["41d77a88", "2fae890e", "7aa8424d", "1d6d311a"],
  run: async (driver) => {
    const outcomes: Array<unknown> = []
    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "ident",
        execute: async (_state, message) => {
          if (message.content === "own id") return { ...message, id: "chosen_id", created_at: 12345 }
          if (message.content === "json metadata")
            return { ...message, metadata: JSON.stringify({ flow: "x" }) as unknown as Record<string, unknown> }
          if (message.content === "taken id" || message.content === "reply") return { ...message, id: "chosen_id" }
          if (message.content === "bad shape") return { ...message, id: 42 as unknown as string }
          return message
        },
      }),
      defineHook({
        hook: "before_update_message",
        id: "stamp_update",
        execute: async (_state, _id, updates) =>
          updates.content === "stamped" ? { ...updates, updated_at: 1 } : { ...updates, silent: updates.silent },
      }),
    ]
    const settle = <A>(promise: Promise<A>) =>
      promise.then(
        (value) => ["resolved", value],
        (error: unknown) => ["rejected", error instanceof Error ? error.message : String(error)],
      )
    const tools = {
      probe: defineTool({
        description: "Inject with chosen identities",
        execute: async (state: ThreadState) => {
          const own = await state.injectMessage({ role: "user", content: "own id" })
          outcomes.push([own.id, own.created_at, (await state.getMessage("chosen_id"))?.content])
          outcomes.push((await state.injectMessage({ role: "user", content: "json metadata" })).metadata)
          outcomes.push(await settle(state.injectMessage({ role: "user", content: "taken id" })))
          outcomes.push(await settle(state.injectMessage({ role: "user", content: "bad shape" })))
          outcomes.push(await settle(state.updateMessage(own.id, { content: "stamped" })))
          const passed = { content: "kept key", silent: true } as { content: string }
          outcomes.push(await settle(state.updateMessage(own.id, passed).then((message) => message.content)))
          return ok("probed")
        },
      }),
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "probe", arguments: {} }] },
      { text: "reply" },
    ])
    await using(
      driver,
      { provider, tools, hooks, prompt: { hooks: ["ident", "stamp_update"] } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const stored = await session.messages(thread)
        expect(stored.map((m) => m.content)).toEqual(["go", null, "kept key", "json metadata", "probed", "reply"])
        expect(stored.filter((m) => m.id === "chosen_id").map((m) => m.content)).toEqual(["kept key"])
        expect(stored.at(-1)?.id).not.toBe("chosen_id")
      },
    )
    expect(outcomes).toEqual([
      ["chosen_id", 12345, "own id"],
      { flow: "x" },
      ["rejected", 'a message with id "chosen_id" already exists'],
      [
        "rejected",
        "Hook ident (before_create_message) returned a value that is not a message the store can hold, with the role, the tool calls, and the call id it was given, so Spindle did not make the change",
      ],
      [
        "rejected",
        "Hook stamp_update (before_update_message) returned a value that is not updates that change only content and metadata, so Spindle did not make the change",
      ],
      ["resolved", "kept key"],
    ])
  },
}

export const H9c: Scenario = {
  name: "H9c fails the hook that gives the human's message, the model's response, or a tool result a taken id, and keeps the later hooks' changes",
  requirements: ["41d77a88", "3d8dede1"],
  run: async (driver) => {
    let taken = ""
    const given: Array<string> = []
    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "take_id",
        execute: async (_state, message) => ({ ...message, id: taken }),
      }),
      defineHook({
        hook: "before_create_message",
        id: "stamp_after",
        execute: async (_state, message) => {
          given.push(message.id)
          return { ...message, metadata: { ...message.metadata, stamped: true } }
        },
      }),
    ]
    const provider = new ScriptedProvider([
      { text: "reply", toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
      { text: "done" },
    ])
    await using(
      driver,
      { provider, tools: noop, hooks, agent: { hooks: ["take_id", "stamp_after"] } },
      async (session, thread) => {
        await session.seed(thread, [{ role: "user", content: "first" }])
        const [first] = await session.messages(thread)
        taken = first?.id ?? ""
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const stored = await session.messages(thread)
        expect(stored[0]).toEqual(first)
        const written = stored.slice(1)
        expect(written.map((m) => [m.role, m.content, m.metadata])).toEqual([
          ["user", "go", { stamped: true }],
          ["assistant", "reply", { stamped: true }],
          ["tool", "noop", { stamped: true }],
          ["assistant", "done", { stamped: true }],
        ])
        expect(given).toEqual(written.map((m) => m.id))
        expect(new Set(stored.map((m) => m.id)).size).toBe(stored.length)
        expect(session.logs().join("\n")).toContain("Hook take_id (before_create_message")
      },
    )
  },
}

export const H10: Scenario = {
  name: "H10 refuses a write whose before hook fails, keeps a write whose after hook fails, and finishes the turn",
  requirements: ["765e84ae", "9d7eaeac", "e1b53f31", "d7e8a202", "3d8dede1"],
  run: async (driver) => {
    const afters: Array<string | null> = []
    const afterUpdates: Array<string | null> = []
    const outcomes: Array<unknown> = []
    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "veto",
        execute: async (_state, message) => {
          if (message.content === "veto me" || message.role === "assistant") throw new Error("no")
          return message
        },
      }),
      defineHook({
        hook: "after_create_message",
        id: "after_boom",
        execute: async (_state, message) => {
          afters.push(message.content)
          if (message.content === "after boom") throw new Error("after")
        },
      }),
      defineHook({
        hook: "before_update_message",
        id: "veto_update",
        execute: async (_state, _id, updates) => {
          if (updates.content === "veto update") throw new Error("no update")
          return updates
        },
      }),
      defineHook({
        hook: "after_update_message",
        id: "after_update_boom",
        execute: async (_state, message) => {
          afterUpdates.push(message.content)
          throw new Error("after update")
        },
      }),
    ]
    const settle = <A>(promise: Promise<A>) =>
      promise.then(
        (value) => ["resolved", value],
        (error: unknown) => ["rejected", error instanceof Error ? error.message : String(error)],
      )
    const tools = {
      writer: defineTool({
        description: "Write and update",
        execute: async (state: ThreadState) => {
          outcomes.push(await settle(state.injectMessage({ role: "user", content: "veto me" })))
          const kept = await state.injectMessage({ role: "user", content: "after boom" })
          outcomes.push((await state.getMessage(kept.id))?.content)
          outcomes.push(await settle(state.updateMessage(kept.id, { content: "veto update" })))
          outcomes.push((await state.getMessage(kept.id))?.content)
          outcomes.push(await settle(state.updateMessage(kept.id, { content: "after update" })))
          outcomes.push((await state.getMessage(kept.id))?.content)
          return ok("wrote")
        },
      }),
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "writer", arguments: {} }] },
      { text: "done" },
    ])
    await using(driver, { provider, tools, hooks, prompt: { hooks: hookIds(hooks) } }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({
        status: "idle",
        reason: "stop_on_response",
        steps: 2,
      })
      const stored = await session.messages(thread)
      expect(stored.map((m) => [m.role, m.content])).toEqual([
        ["user", "go"],
        ["assistant", null],
        ["user", "after update"],
        ["tool", "wrote"],
        ["assistant", "done"],
      ])
      expect(outcomes[0]).toEqual([
        "rejected",
        "Hook veto (before_create_message) threw an error, so Spindle did not make the change",
      ])
      expect(outcomes.slice(1)).toEqual([
        "after boom",
        ["rejected", "Hook veto_update (before_update_message) threw an error, so Spindle did not make the change"],
        "after boom",
        ["resolved", expect.objectContaining({ content: "after update" })],
        "after update",
      ])
      expect(afters).not.toContain("veto me")
      expect(afters.filter((content) => content === "after boom")).toHaveLength(1)
      expect(afterUpdates).toEqual(["after update"])
      expect(session.logs().join("\n")).toContain("Hook veto (before_create_message")
    })
  },
}

export const H18: Scenario = {
  name: "H18 stores an injected user, assistant, or system message as given and presents it by perspective",
  requirements: ["b74ef581", "8fe975d3", "487717df", "37cadafc"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const returned: Array<Message> = []
      const tools = {
        inject: defineTool({
          description: "Inject one of each role",
          execute: async (state: ThreadState) => {
            returned.push(await state.injectMessage({ role: "user", content: "from B", metadata: { n: 1 } }))
            returned.push(await state.injectMessage({ role: "assistant", content: "from A", silent: true }))
            returned.push(await state.injectMessage({ role: "system", content: "", silent: false }))
            return ok("injected")
          },
        }),
      }
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "inject", arguments: {} }] },
        { text: "done" },
      ])
      await using(driver, { provider, tools, humanOn }, async (session, thread) => {
        await session.send(thread, "go")
        const stored = await session.messages(thread)
        expect(returned.map((m) => [m.role, m.content, m.silent, m.metadata])).toEqual([
          ["user", "from B", false, { n: 1 }],
          ["assistant", "from A", true, {}],
          ["system", "", false, {}],
        ])
        for (const message of returned) expect(stored.find((row) => row.id === message.id)).toEqual(message)
        const presented = history(provider.requests[1])
          .filter((m) => m.role !== "tool" && (m.role !== "assistant" || m.toolCalls === undefined))
          .map((m) => [m.role, m.content])
        expect(presented).toEqual(
          humanOn === "b"
            ? [
                ["user", "go"],
                ["user", "from B"],
                ["assistant", "from A"],
              ]
            : [
                ["user", "go"],
                ["assistant", "from B"],
                ["user", "from A"],
              ],
        )
      })
    }
    // The public input type admits only these three roles and string content.
    const typesOnly = (state: ThreadState) => {
      // @ts-expect-error a tool message is not a public injection
      void state.injectMessage({ role: "tool", content: "x" })
      // @ts-expect-error content is a string
      void state.injectMessage({ role: "user", content: null })
      // @ts-expect-error an update changes content and metadata only
      void state.updateMessage("id", { silent: true })
      // @ts-expect-error attachments belong to a queued message, not an injected one
      void state.injectMessage({ role: "user", content: "x", attachments: [] })
    }
    expect(typeof typesOnly).toBe("function")
  },
}

export const H20: Scenario = {
  name: "H20 lets hooks and tools read each other's key-value writes in one thread",
  requirements: ["70e01371", "b680018e"],
  run: async (driver) => {
    const seen: Array<unknown> = []
    const hooks = [
      defineHook({
        hook: "after_create_message",
        id: "count_messages",
        execute: async (state) => {
          await state.setValue("created", (((await state.getValue("created")) as number | null) ?? 0) + 1)
        },
      }),
      defineHook({
        hook: "filter_messages",
        id: "read_tool_value",
        execute: async (state, messages) => {
          seen.push(["filter", await state.getValue("from_tool")])
          return messages
        },
      }),
    ]
    const tools = {
      kv: defineTool({
        description: "Read and write values",
        execute: async (state: ThreadState) => {
          seen.push(["tool", await state.getValue("created")])
          await state.setValue("from_tool", "tool wrote this")
          return ok("ok")
        },
      }),
    }
    const provider = new ScriptedProvider([{ toolCalls: [{ id: "c1", name: "kv", arguments: {} }] }, { text: "done" }])
    await using(driver, { provider, tools, hooks, agent: { hooks: hookIds(hooks) } }, async (session, thread) => {
      await session.send(thread, "go")
      expect(await (await session.state(thread)).getValue("created")).toBe(4)
    })
    expect(seen).toEqual([
      ["filter", null],
      ["tool", 2],
      ["filter", "tool wrote this"],
    ])
  },
}
