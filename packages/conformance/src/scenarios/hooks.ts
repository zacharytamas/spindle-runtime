import {
  type AttachmentRef,
  defineHook,
  defineTool,
  type HookExecutionContext,
  type HookToolResult,
  type LLMMessage,
  type Message,
  type ProviderStreamChunk,
  type ThreadState,
} from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider } from "../ScriptedProvider.ts"
import { rolesFor, SIDES } from "./messages.ts"
import { history, holding, ok, project, type Scenario, type Setup, send, sideOf, using } from "./step-loop.ts"

const noop = { noop: defineTool({ description: "Does nothing", execute: async () => ok("noop") }) }

const toolRows = (messages: ReadonlyArray<Message>) =>
  messages.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.tool_status, m.content])

const ref = (id: string): AttachmentRef => ({
  id,
  type: "file",
  path: `/files/${id}.txt`,
  name: `${id}.txt`,
  mimeType: "text/plain",
  size: 4,
})

const hookIds = (hooks: Setup["hooks"]) => (hooks ?? []).map((hook) => hook.id)

export const hookScenarios: ReadonlyArray<Scenario> = [
  {
    name: "H8 runs the prompt's hook list as the whole set, the agent's list when the prompt lists none, and nothing else",
    requirements: ["216a047a", "41bdae5c", "6fc64bc7", "dce1c8bc", "17286533", "f66e7c81", "f7da5f56", "3b4fc9bc"],
    run: async (driver) => {
      const events: Array<unknown> = []
      const hooks = [
        defineHook({
          hook: "filter_messages",
          id: "f_one",
          execute: async (state, messages, context) => {
            events.push(["f_one", context.source, typeof state.threadId])
            state.context.source = { kind: "prompt", promptName: "imposter" }
            return [...messages, { id: "marker", role: "user", content: "from f_one", created_at: 0 }]
          },
        }),
        defineHook({
          hook: "filter_messages",
          id: "f_two",
          execute: async (_state, messages, context) => {
            events.push(["f_two", context.source, messages.at(-1)?.content])
            return messages
          },
        }),
        defineHook({
          hook: "filter_messages",
          id: "f_agent",
          execute: async (_state, messages, context) => {
            events.push(["f_agent", context.source])
            return messages
          },
        }),
        defineHook({
          hook: "before_create_message",
          id: "c_agent",
          execute: async (_state, message, context) => {
            events.push(["c_agent", message.content, context.source])
            return message
          },
        }),
        defineHook({
          hook: "after_thread_created",
          id: "born",
          execute: async (state, context) => {
            events.push(["born", context.source, state.execution, (await state.getMessages()).total])
            await state.setValue("source", { kind: "prompt", promptName: "imposter" })
          },
        }),
        defineHook({
          hook: "filter_messages",
          id: "f_unused",
          execute: async (_state, messages) => {
            events.push(["f_unused"])
            return messages
          },
        }),
      ]
      const agent = { kind: "agent", agentName: "assistant" }
      const prompt = { kind: "prompt", promptName: "helper" }
      const run = async (humanOn: "a" | "b", lists: Pick<Setup, "agent" | "prompt">) => {
        events.length = 0
        const provider = new ScriptedProvider([{ text: "answer" }])
        const created: Array<unknown> = []
        const named = { ...lists, side: { prompt: "helper" }, prompt: { name: "helper", ...lists.prompt } }
        await using(driver, { provider, hooks, humanOn, ...named }, async (session, thread) => {
          created.push(...events)
          events.length = 0
          await send(session, thread, "go")
        })
        return { created, sent: [...events], request: provider.requests[0] }
      }
      const agentList = { hooks: ["f_agent", "c_agent", "born"] }
      for (const humanOn of SIDES) {
        const both = await run(humanOn, { agent: agentList, prompt: { hooks: ["f_one", "f_two"] } })
        expect(both.created).toEqual([["born", agent, null, 0]])
        expect(both.sent).toEqual([
          ["c_agent", "go", agent],
          ["f_one", prompt, "string"],
          ["f_two", prompt, "from f_one"],
        ])
        expect(history(both.request).map(sideOf)).toEqual([
          ["user", "go"],
          humanOn === "b" ? ["user", "from f_one"] : ["assistant", "from f_one", []],
        ])
      }
      for (const promptList of [{ hooks: [] }, {}]) {
        const fallback = await run("b", { agent: agentList, prompt: promptList })
        expect(fallback.created).toEqual([["born", agent, null, 0]])
        expect(fallback.sent).toEqual([
          ["c_agent", "go", agent],
          ["f_agent", agent],
          ["c_agent", "answer", agent],
        ])
      }
      const neither = await run("b", {})
      expect(neither.created).toEqual([])
      expect(neither.sent).toEqual([])
    },
  },
  {
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
            await send(session, thread, "go")
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
  },
  {
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
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
  },
  {
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
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
  },
  {
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
        expect(await send(session, thread, "go")).toMatchObject({
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
  },
  {
    name: "H11 replays the reasoning of each assistant message that survives the request hooks and of no other, and none when include is false",
    requirements: ["80b5ff9b", "b9e3d243", "6e1d2f01"],
    run: async (driver) => {
      const source = { definition: "scripted", model: "scripted-model-v1" }
      const seed = (humanOn: "a" | "b") => {
        const { human, model } = rolesFor(humanOn)
        return [
          { role: human, content: "q1" },
          {
            role: model,
            content: "a1",
            reasoning_content: "thought one",
            reasoning_details: JSON.stringify([{ type: "reasoning.text", text: "detail one" }]),
            metadata: { reasoning_source: source },
          },
          { role: human, content: "q2" },
          {
            role: model,
            content: "a2",
            reasoning_content: "thought two",
            reasoning_details: JSON.stringify([{ type: "reasoning.text", text: "detail two" }]),
            metadata: { reasoning_source: source },
          },
        ]
      }
      const requestOf = async (humanOn: "a" | "b", hooks: Setup["hooks"], include?: boolean) => {
        const provider = new ScriptedProvider([{ text: "done" }])
        await using(
          driver,
          {
            provider,
            humanOn,
            ...(hooks === undefined ? {} : { hooks }),
            prompt: {
              includeChat: true,
              hooks: hookIds(hooks),
              ...(include === undefined ? {} : { reasoning: { include } }),
            },
          },
          async (session, thread) => {
            await session.seed(thread, seed(humanOn))
            await send(session, thread, "q3")
          },
        )
        return provider.requests[0]
      }
      const dropFilter = defineHook({
        hook: "filter_messages",
        id: "drop_a1",
        execute: async (_state, messages) => messages.filter((m) => m.content !== "a1"),
      })
      const dropPrefilter = defineHook({
        hook: "prefilter_llm_history",
        id: "drop_a2",
        execute: async (_state, messages) => messages.filter((m) => m.content !== "a2"),
      })
      const pass = defineHook({
        hook: "prefilter_llm_history",
        id: "pass",
        execute: async (_state, messages) => messages,
      })
      const restore = defineHook({
        hook: "prefilter_llm_history",
        id: "restore",
        execute: async (state, messages) => {
          const stored = state.execution?.messageHistory.find((m) => m.content === "a2")
          return messages.map((m) =>
            m.content === "a2"
              ? {
                  ...m,
                  reasoning_content: stored?.reasoning_content ?? "",
                  reasoning_details: JSON.parse(stored?.reasoning_details ?? "[]"),
                }
              : m,
          )
        },
      })
      const replayed = (n: string, word: string) => ({
        role: "assistant",
        content: `a${n}`,
        reasoning: `thought ${word}`,
        reasoningDetails: [{ type: "reasoning.text", text: `detail ${word}` }],
      })
      const assistants = (request: Awaited<ReturnType<typeof requestOf>>) =>
        history(request).filter((m) => m.role === "assistant")
      for (const humanOn of SIDES) {
        const plain = await requestOf(humanOn, undefined)
        expect(assistants(plain)).toEqual([replayed("1", "one"), replayed("2", "two")])
        expect(await requestOf(humanOn, [pass])).toEqual(plain)
        expect(assistants(await requestOf(humanOn, [dropFilter]))).toEqual([replayed("2", "two")])
        expect(assistants(await requestOf(humanOn, [dropPrefilter]))).toEqual([replayed("1", "one")])
        const bare = [
          { role: "assistant", content: "a1" },
          { role: "assistant", content: "a2" },
        ]
        const excluded = await requestOf(humanOn, [pass], false)
        expect(assistants(excluded)).toEqual(bare)
        expect(JSON.stringify(excluded)).not.toMatch(/thought|detail/)
        const restored = await requestOf(humanOn, [restore], false)
        expect(assistants(restored)).toEqual(bare)
        expect(JSON.stringify(restored)).not.toMatch(/thought|detail/)
      }
    },
  },
  {
    name: "H11b sends every field of the array prefilter_llm_history returns that a provider message can hold",
    requirements: ["dfde10dc", "5cf7c4b6"],
    run: async (driver) => {
      const requestWith = async (returned: Array<LLMMessage>) => {
        const provider = new ScriptedProvider([{ text: "done" }])
        const hooks = [
          defineHook({
            hook: "prefilter_llm_history",
            id: "final_array",
            execute: async (_state, messages) => [...messages, ...returned],
          }),
        ]
        let logs = ""
        await using(driver, { provider, hooks, prompt: { hooks: ["final_array"] } }, async (session, thread) => {
          await send(session, thread, "go")
          logs = session.logs().join("\n")
        })
        return { history: history(provider.requests[0]), logs }
      }
      const image = { type: "image", data: "aGk=", mediaType: "image/png" }
      const kept = await requestWith([
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "x1",
              type: "function",
              function: { name: "noop", arguments: '{"a":1}' },
              extra_content: { sig: "s" },
            },
          ],
          reasoning_content: "why",
          reasoning_details: [{ type: "text", text: "detail" }],
        },
        { role: "tool", tool_call_id: "x1", name: "noop", content: [{ type: "text", text: "wrapped" }] },
        { role: "user", content: [{ type: "text", text: "look" }, image] },
      ])
      expect(kept.history).toEqual([
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "x1", name: "noop", arguments: { a: 1 }, extraContent: { sig: "s" } }],
          reasoning: "why",
          reasoningDetails: [{ type: "text", text: "detail" }],
        },
        { role: "tool", toolCallId: "x1", toolName: "noop", content: [{ type: "text", text: "wrapped" }] },
        { role: "user", content: [{ type: "text", text: "look" }, image] },
      ])
      for (const odd of [
        { role: "assistant", content: [{ type: "text", text: "caption" }, image] },
        { role: "system", content: [{ type: "text", text: "rules" }] },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "x2", function: { name: "noop", arguments: "not json" } }],
        },
        { role: "user", content: [{ type: "image", data: 7 }] },
        { role: "tool", tool_call_id: "x3", name: "noop", content: { type: "text", text: "an object" } },
        {
          role: "tool",
          tool_call_id: "x4",
          name: "noop",
          tool_status: "error",
          content: [{ type: "text", text: "e" }],
        },
      ] as Array<LLMMessage>) {
        const refused = await requestWith([odd])
        expect(refused.history).toEqual([{ role: "user", content: "go" }])
        expect(refused.logs).toContain("Hook final_array (prefilter_llm_history")
      }
    },
  },
  {
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
          await send(session, thread, "go")
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
  },
  {
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
      await using(driver, { provider, tools, hooks, prompt: { hooks: hookIds(hooks) } }, async (session, thread) => {
        await send(session, thread, "go")
      })
      expect(events).toEqual([
        ["success", "c1", ["fine"]],
        ["store", "c1", false],
        ["failure", "c2", ["fine", "refuse"]],
        ["store", "c2", false],
        ["failure", "c3", ["fine", "refuse"]],
        ["store", "c3", false],
      ])
    },
  },
  {
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
          await send(session, thread, "go")
        },
        { MARK: "hidden-value-58" },
      )
      expect(done).toEqual([
        ["c1", "success", "value [redacted] [store] [create]", "value [redacted] [store] [create]"],
        ["c2", "error", "refused [store] [create]", "refused [store] [create]"],
      ])
    },
  },
  {
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
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 1 })
          expect(toolRows(await session.messages(thread))).toEqual([])
        },
      )
      expect(events).toEqual([
        ["started", "c_lost"],
        ["done", "c_lost", "error", "Spindle did not run this call, because the model response that held it failed."],
      ])
    },
  },
  {
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
      await using(driver, { provider, tools, hooks, prompt: { hooks: ["watch"] } }, async (session, thread) => {
        await send(session, thread, "go")
      })
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
  },
  {
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
        await send(session, thread, "go")
        stored = await session.messages(thread)
      })
      expect(seen).toEqual([
        ["c_files", "rewritten two files", [ref("original")]],
        ["c_broken", "recovered", [ref("from_failure")]],
        ["c_make", "rewritten made", [fresh]],
      ])
      const rows = stored.filter((m) => m.role === "tool")
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
  },
  {
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
      const loaded = await driver.load(project({ provider, tools: noop, hooks, prompt: { hooks: hookIds(hooks) } }), {
        hookTimeoutMs: 150,
      })
      try {
        const thread = await loaded.createThread("assistant")
        const started = Date.now()
        const outcome = await send(loaded, thread, "go")
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
      } finally {
        await loaded.close()
      }
    },
  },
  {
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
      const loaded = await driver.load(
        project({ provider, hooks, prompt: { hooks: hookIds(hooks), includeChat: true } }),
        {
          hookTimeoutMs: 150,
        },
      )
      try {
        const thread = await loaded.createThread("assistant")
        expect(await send(loaded, thread, "go")).toMatchObject({ status: "idle", steps: 1 })
        expect(await lateCall).toMatch(/^HookExpired: Hook slow_writer \(filter_messages\) ran past its time limit/)
        await send(loaded, thread, "next")
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
      } finally {
        await loaded.close()
      }
    },
  },
  {
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
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
  },
  {
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
        expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
        for (const id of ["boom_created", "boom_started", "boom_done", "boom_store"])
          expect(logs).toContain(`Hook ${id}`)
      })
    },
  },
  {
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
          await send(session, thread, "go")
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
  },
  {
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
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "kv", arguments: {} }] },
        { text: "done" },
      ])
      await using(driver, { provider, tools, hooks, agent: { hooks: hookIds(hooks) } }, async (session, thread) => {
        await send(session, thread, "go")
        expect(await (await session.state(thread)).getValue("created")).toBe(4)
      })
      expect(seen).toEqual([
        ["filter", null],
        ["tool", 2],
        ["filter", "tool wrote this"],
      ])
    },
  },
  {
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
          await send(session, thread, `hello ${marker}`)
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
        { MARK: marker },
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
          const outcome = await send(session, thread, "go")
          expect(outcome).toMatchObject({ status: "failed", reason: "fatal_error" })
          expect(outcome.error?.message).toMatch(/holds a secret value/)
          expect(JSON.stringify(outcome)).not.toContain(marker)
        },
        { MARK: marker },
      )
      expect(never.requests).toHaveLength(0)
    },
  },
  {
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
          await send(session, thread, "go")
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
        instance,
      )
      for (const secret of Object.values(instance)) expect(holding(provider.requests, secret)).toEqual([])
    },
  },
  {
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
            outcome = await send(session, thread, "go")
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
  },
  {
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
          expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
  },
  {
    name: "H21 calls each of the thirteen hook types with ThreadState first, its own arguments, and the context last",
    requirements: ["986689ca", "4b6bc420", "41bdae5c", "bf795e82", "04d1538b", "048a4525"],
    run: async (driver) => {
      const calls: Array<unknown> = []
      const facts: Array<unknown> = []
      const shape = (value: unknown): unknown =>
        Array.isArray(value)
          ? "array"
          : typeof value === "object" && value !== null
            ? Object.keys(value).filter((key) => ["id", "role", "status", "function", "content"].includes(key))
            : typeof value
      const record =
        (name: string, give?: (args: Array<unknown>) => unknown) =>
        async (...args: Array<unknown>) => {
          const state = args[0] as ThreadState
          const context = args.at(-1) as HookExecutionContext
          const execution = state.execution
          if (name === "filter_messages" && execution !== null)
            facts.push([
              execution.stepCount,
              execution.currentSide,
              execution.abortSignal instanceof AbortSignal,
              execution.messageHistory.length,
            ])
          calls.push([
            name,
            typeof state.threadId,
            state.execution === null ? "at rest" : "running",
            args.slice(1, -1).map(shape),
            context.source.kind,
          ])
          return give?.(args.slice(1, -1))
        }
      const positions: Array<[string, ((args: Array<unknown>) => unknown) | undefined]> = [
        ["after_thread_created", undefined],
        ["after_system_message", () => null],
        ["filter_messages", (args) => args[0]],
        ["prefilter_llm_history", (args) => args[0]],
        ["before_create_message", (args) => args[0]],
        ["after_create_message", undefined],
        ["before_update_message", (args) => args[1]],
        ["after_update_message", undefined],
        ["before_store_tool_result", (args) => args[1]],
        ["after_tool_call_success", () => null],
        ["after_tool_call_failure", () => null],
        ["tool_call_started", undefined],
        ["tool_call_done", undefined],
      ]
      const hooks = positions.map(([name, give]) =>
        defineHook({ hook: name as "tool_call_done", id: `every_${name}`, execute: record(name, give) as never }),
      )
      const tools = {
        edit: defineTool({
          description: "Edit the human's message",
          execute: async (state: ThreadState) => {
            const first = state.execution?.messageHistory[0]
            await state.updateMessage(first?.id ?? "", { metadata: { seen: true } })
            return ok("edited")
          },
        }),
        fail: defineTool({
          description: "Fail",
          execute: async () => ({ status: "error" as const, error: "failed" }),
        }),
      }
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c1", name: "edit", arguments: {} },
            { id: "c2", name: "fail", arguments: {} },
          ],
        },
        { text: "done" },
      ])
      await using(driver, { provider, tools, hooks, agent: { hooks: hookIds(hooks) } }, async (session, thread) => {
        await send(session, thread, "go")
      })
      const names = new Set(calls.map((call) => (call as Array<unknown>)[0]))
      expect(names.size).toBe(13)
      expect(facts).toEqual([
        [0, "a", true, 1],
        [1, "a", true, 4],
      ])
      const first = (name: string) => calls.find((call) => (call as Array<unknown>)[0] === name) as Array<unknown>
      expect(first("after_thread_created")).toEqual(["after_thread_created", "string", "at rest", [], "agent"])
      expect(first("before_create_message")).toEqual([
        "before_create_message",
        "string",
        "at rest",
        [["id", "role", "content", "status"]],
        "agent",
      ])
      expect(first("after_system_message")).toEqual(["after_system_message", "string", "running", ["string"], "agent"])
      expect(first("filter_messages")).toEqual(["filter_messages", "string", "running", ["array"], "agent"])
      expect(first("prefilter_llm_history")).toEqual(["prefilter_llm_history", "string", "running", ["array"], "agent"])
      expect(first("before_update_message")).toEqual([
        "before_update_message",
        "string",
        "running",
        ["string", []],
        "agent",
      ])
      expect(first("after_create_message")).toEqual([
        "after_create_message",
        "string",
        "at rest",
        [["id", "role", "content", "status"]],
        "agent",
      ])
      expect(first("after_update_message")).toEqual([
        "after_update_message",
        "string",
        "running",
        [["id", "role", "content", "status"]],
        "agent",
      ])
      expect(
        calls.filter((call) => (call as Array<unknown>)[2] === "at rest").map((call) => (call as Array<unknown>)[0]),
      ).toEqual(["after_thread_created", "before_create_message", "after_create_message"])
      expect(first("tool_call_started")).toEqual([
        "tool_call_started",
        "string",
        "running",
        [["id", "function"], "undefined"],
        "agent",
      ])
      for (const name of [
        "after_tool_call_success",
        "after_tool_call_failure",
        "before_store_tool_result",
        "tool_call_done",
      ])
        expect(first(name)).toEqual([name, "string", "running", [["id", "function"], ["status"]], "agent"])
    },
  },
]
