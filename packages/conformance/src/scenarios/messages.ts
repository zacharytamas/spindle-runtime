import {
  defineHook,
  definePrompt,
  defineTool,
  type HookExecutionContext,
  type LLMMessage,
  type Message,
  type ThreadState,
} from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../ScriptedProvider.ts"
import { history, ok, type Scenario, send, sideOf, using } from "./step-loop.ts"

export const SIDES = ["b", "a"] as const

// The human's stored role and the model side's stored role. Messages section 4: user is side B, assistant is side A.
export const rolesFor = (humanOn: "a" | "b") =>
  humanOn === "b" ? ({ human: "user", model: "assistant" } as const) : ({ human: "assistant", model: "user" } as const)

const contents = (messages: ReadonlyArray<{ readonly content?: unknown }>) => messages.map((m) => m.content)

const noop = { noop: defineTool({ description: "Does nothing", execute: async () => ok("noop") }) }

const system = { role: "system", content: "You are a test assistant." }

// Messages section 7, one scenario per row, each with the human on side B and then on side A.
export const messageScenarios: ReadonlyArray<Scenario> = [
  {
    name: "M1 runs each create hook once for a message a tool injects, and later tools and hooks see the stored row",
    requirements: ["41d77a88", "8254ece3", "8cefb16e", "22cf59fa", "b74ef581", "73bce32e", "4fcc1f95"],
    run: async (driver) => {
      for (const humanOn of SIDES) {
        const before: Array<Message> = []
        const after: Array<Message> = []
        const filtered: Array<Array<string>> = []
        const live: Array<Array<string>> = []
        const seen: Array<unknown> = []
        const liveIds = (state: ThreadState) => (state.execution?.messageHistory ?? []).map((message) => message.id)
        const hooks = [
          defineHook({
            hook: "before_create_message",
            id: "stamp",
            execute: async (_state, message) => {
              before.push(message)
              return { ...message, metadata: { ...message.metadata, stamped: message.id } }
            },
          }),
          defineHook({
            hook: "after_create_message",
            id: "record",
            execute: async (_state, message) => {
              after.push(message)
            },
          }),
          defineHook({
            hook: "filter_messages",
            id: "look",
            execute: async (state, messages) => {
              filtered.push(messages.map((message) => message.id))
              live.push(liveIds(state))
              return messages
            },
          }),
          defineHook({
            hook: "tool_call_done",
            id: "after_tool",
            execute: async (state, toolCall) => {
              if (toolCall.id === "c_inject") live.push(liveIds(state))
            },
          }),
        ]
        const tools = {
          inject: defineTool({
            description: "Inject a note",
            execute: async (state: ThreadState) => {
              const message = await state.injectMessage({ role: "user", content: "note", metadata: { source: "tool" } })
              const read = await state.getMessage(message.id)
              const listed = await state.getMessages({ order: "asc", includeSilent: true })
              seen.push({ message, read, last: listed.messages.at(-1) })
              return ok("injected")
            },
          }),
          observe: defineTool({
            description: "Look at the live history",
            execute: async (state: ThreadState) => {
              seen.push((state.execution?.messageHistory ?? []).map((message) => message.id))
              return ok("observed")
            },
          }),
        }
        const provider = new ScriptedProvider([
          {
            toolCalls: [
              { id: "c_inject", name: "inject", arguments: {} },
              { id: "c_observe", name: "observe", arguments: {} },
            ],
          },
          { text: "done" },
        ])
        await using(
          driver,
          { provider, tools, hooks, humanOn, prompt: { hooks: ["stamp", "record", "look", "after_tool"] } },
          async (session, thread) => {
            expect(await send(session, thread, "go")).toMatchObject({ status: "idle", steps: 2 })
            const stored = await session.messages(thread)
            const { message, read, last } = seen[0] as Record<string, Message>
            expect(message?.metadata).toEqual({ source: "tool", stamped: message?.id })
            expect(read).toEqual(message)
            expect(last).toEqual(message)
            expect(stored.find((row) => row.id === message?.id)).toEqual(message)
            const injected = before.filter((row) => row.content === "note")
            expect(injected.map((row) => [row.id, row.created_at])).toEqual([[message?.id, message?.created_at]])
            expect(after.filter((row) => row.id === message?.id)).toEqual([message])
            const ids = stored.map((row) => row.id)
            expect(seen[1]).toEqual(ids.slice(0, 4))
            expect(ids[2]).toBe(message?.id)
            expect(filtered[1]).toEqual(ids.slice(0, 5))
            expect(live).toEqual([ids.slice(0, 1), ids.slice(0, 4), ids.slice(0, 5)])
          },
        )
      }
    },
  },
  {
    name: "M2 runs the agent's create hooks for a message injected at rest and makes it readable before any run",
    requirements: ["22cf59fa", "a63f8e52", "251bf5a2", "3b4fc9bc", "04d1538b", "048a4525", "4029d475"],
    run: async (driver) => {
      for (const humanOn of SIDES) {
        const { human } = rolesFor(humanOn)
        const calls: Array<unknown> = []
        const record =
          (id: string) =>
          async (state: ThreadState, message: Message, context: HookExecutionContext): Promise<Message> => {
            calls.push([id, message.content, context.source, state.execution === null])
            return message
          }
        const hooks = [
          defineHook({ hook: "before_create_message", id: "agent_before", execute: record("agent_before") }),
          defineHook({
            hook: "after_create_message",
            id: "agent_after",
            execute: async (state, message, context) => {
              await record("agent_after")(state, message, context)
            },
          }),
          defineHook({ hook: "before_create_message", id: "prompt_before", execute: record("prompt_before") }),
          ...["agent_update", "prompt_update"].map((id) =>
            defineHook({
              hook: "before_update_message",
              id,
              execute: async (state, _messageId, updates, context) => {
                calls.push([id, updates.content, context.source, state.execution === null])
                return updates
              },
            }),
          ),
        ]
        const provider = new ScriptedProvider([{ text: "answer" }])
        await using(
          driver,
          {
            provider,
            hooks,
            humanOn,
            agent: { hooks: ["agent_before", "agent_after", "agent_update"] },
            side: { prompt: "helper" },
            prompt: { name: "helper", hooks: ["prompt_before", "prompt_update"], includeChat: true },
          },
          async (session, thread) => {
            const state = await session.state(thread)
            expect(state.execution).toBeNull()
            const message = await state.injectMessage({ role: human, content: "idle note", metadata: { k: 1 } })
            expect(await state.getMessage(message.id)).toEqual(message)
            expect(await session.messages(thread)).toEqual([message])
            const edited = await state.updateMessage(message.id, { content: "idle edit" })
            expect(await session.messages(thread)).toEqual([edited])
            expect(provider.requests).toHaveLength(0)
            const agent = { kind: "agent", agentName: "assistant" }
            expect(calls).toEqual([
              ["agent_before", "idle note", agent, true],
              ["agent_after", "idle note", agent, true],
              ["agent_update", "idle edit", agent, true],
            ])
            calls.length = 0
            await send(session, thread, "go")
            expect(history(provider.requests[0]).map(sideOf)).toEqual([
              ["user", "idle edit"],
              ["user", "go"],
            ])
            expect(calls).toEqual([
              ["agent_before", "go", agent, true],
              ["agent_after", "go", agent, true],
              ["prompt_before", "answer", { kind: "prompt", promptName: "helper" }, false],
            ])
          },
        )
      }
    },
  },
  {
    name: "M3 stores a silent and a visible injection alike and hides only the silent one from a default read",
    requirements: ["e44a42aa", "dca92c64", "79171656", "e4ba69e7", "da639364", "35d60289", "61c7bee3"],
    run: async (driver) => {
      for (const humanOn of SIDES) {
        const { human } = rolesFor(humanOn)
        const created: Array<string | null> = []
        const filtered: Array<Array<unknown>> = []
        const prefiltered: Array<Array<unknown>> = []
        const reads: Array<unknown> = []
        const hooks = [
          defineHook({
            hook: "before_create_message",
            id: "count_before",
            execute: async (_state, message) => {
              created.push(`before ${message.content}`)
              return message
            },
          }),
          defineHook({
            hook: "after_create_message",
            id: "count_after",
            execute: async (_state, message) => {
              created.push(`after ${message.content}`)
            },
          }),
          defineHook({
            hook: "filter_messages",
            id: "pass_filter",
            execute: async (_state, messages) => {
              filtered.push(messages.map((message) => [message.content, message.silent]))
              return messages
            },
          }),
          defineHook({
            hook: "prefilter_llm_history",
            id: "pass_prefilter",
            execute: async (_state, messages) => {
              prefiltered.push(contents(messages))
              return messages
            },
          }),
        ]
        const tools = {
          inject_both: defineTool({
            description: "Inject two notes",
            execute: async (state: ThreadState) => {
              const loud = await state.injectMessage({ role: human, content: "loud note" })
              const quiet = await state.injectMessage({ role: human, content: "quiet note", silent: true })
              reads.push([loud.silent, quiet.silent])
              reads.push(contents((await state.getMessages({ order: "asc" })).messages))
              reads.push(contents((await state.getMessages({ order: "asc", includeSilent: true })).messages))
              return ok("injected")
            },
          }),
          observe: defineTool({
            description: "Look at the live history",
            execute: async (state: ThreadState) => {
              reads.push(contents(state.execution?.messageHistory ?? []))
              return ok("observed")
            },
          }),
        }
        const provider = new ScriptedProvider([
          {
            toolCalls: [
              { id: "c1", name: "inject_both", arguments: {} },
              { id: "c2", name: "observe", arguments: {} },
            ],
          },
          { text: "done" },
        ])
        await using(
          driver,
          {
            provider,
            tools,
            hooks,
            humanOn,
            prompt: { hooks: ["count_before", "count_after", "pass_filter", "pass_prefilter"] },
          },
          async (session, thread) => {
            await send(session, thread, "go")
            const stored = await session.messages(thread)
            expect(stored.filter((m) => m.content?.endsWith("note")).map((m) => [m.content, m.silent])).toEqual([
              ["loud note", false],
              ["quiet note", true],
            ])
            expect(created.filter((entry) => entry?.endsWith("note"))).toEqual([
              "before loud note",
              "after loud note",
              "before quiet note",
              "after quiet note",
            ])
            expect(reads[0]).toEqual([false, true])
            expect(reads[1]).toEqual(["go", null, "loud note"])
            expect(reads[2]).toEqual(["go", null, "loud note", "quiet note"])
            expect(reads[3]).toEqual(["go", null, "loud note", "quiet note", "injected"])
            expect(filtered[1]).toContainEqual(["quiet note", true])
            expect(filtered[1]).toContainEqual(["loud note", false])
            expect(prefiltered[1]).toEqual(expect.arrayContaining(["loud note", "quiet note"]))
            expect(contents(history(provider.requests[1]))).toEqual(expect.arrayContaining(["loud note", "quiet note"]))
          },
        )
      }
    },
  },
  {
    name: "M4 lets filter_messages and prefilter_llm_history shape only the request while history keeps the stored rows",
    requirements: ["d2ff2793", "2eca3c1a", "5cf7c4b6", "a0834ffa", "cf4e7ca0", "c4905fe6", "77a09885", "07cc7193"],
    run: async (driver) => {
      for (const humanOn of SIDES) {
        const { human, model } = rolesFor(humanOn)
        const checks: Array<unknown> = []
        const hooks = [
          defineHook({
            hook: "filter_messages",
            id: "compact",
            execute: async (_state, messages) => {
              const kept: Array<Message> = []
              for (const message of messages) {
                if (message.content === "u1") continue
                if (message.content === "m1") {
                  kept.push({ id: "synthetic_summary", role: human, content: "summary of u1 and m1", created_at: 0 })
                  continue
                }
                if (message.content === "u2") continue
                if (message.content === "m2") {
                  const note = (message.metadata?.note ?? {}) as Record<string, unknown>
                  note.secret = "hidden"
                  message.content = "m2 edited"
                }
                kept.push(message)
              }
              kept.push({ id: "synthetic_tail", role: human, content: "tail", created_at: 0 })
              return kept
            },
          }),
          defineHook({
            hook: "prefilter_llm_history",
            id: "remind",
            execute: async (_state, messages) => {
              const asked = messages.find((message) => message.content === "u3")
              if (asked !== undefined) asked.content = "u3 (be brief)"
              return [...messages, { role: "user", content: "added by prefilter" }]
            },
          }),
        ]
        const tools = {
          check: defineTool({
            description: "Read the live and the stored history",
            execute: async (state: ThreadState) => {
              checks.push(state.execution?.messageHistory ?? [])
              checks.push((await state.getMessages({ order: "asc", includeSilent: true })).messages)
              return ok("checked")
            },
          }),
        }
        const provider = new ScriptedProvider([
          { toolCalls: [{ id: "c1", name: "check", arguments: {} }] },
          { text: "done" },
        ])
        await using(
          driver,
          { provider, tools, hooks, humanOn, prompt: { hooks: ["compact", "remind"], includeChat: true } },
          async (session, thread) => {
            await session.seed(thread, [
              { role: human, content: "u1" },
              { role: model, content: "m1" },
              { role: human, content: "u2" },
              { role: model, content: "m2", metadata: { note: { secret: "keep-me" } } },
            ])
            await send(session, thread, "u3")
            const stored = await session.messages(thread)
            expect(history(provider.requests[0]).map(sideOf)).toEqual([
              ["user", "summary of u1 and m1"],
              ["assistant", "m2 edited", []],
              ["user", "u3 (be brief)"],
              ["user", "tail"],
              ["user", "added by prefilter"],
            ])
            expect(provider.requests[0]?.messages[0]).toEqual({ role: "system", content: "You are a test assistant." })
            expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(["check"])
            const original = stored.slice(0, 7)
            expect(contents(original)).toEqual(["u1", "m1", "u2", "m2", "u3", null, "checked"])
            expect(original[3]?.metadata).toEqual({ note: { secret: "keep-me" } })
            expect(checks[0]).toEqual(stored.slice(0, 6))
            expect(checks[1]).toEqual(stored.slice(0, 6))
            expect(stored.map((message) => message.id)).not.toContain("synthetic_summary")
            expect(stored.map((message) => message.id)).not.toContain("synthetic_tail")
            expect(stored.map((message) => message.content)).not.toContain("tail")
            expect(stored.map((message) => message.content)).not.toContain("added by prefilter")
          },
        )
      }
    },
  },
  {
    name: "M5 runs the create hooks for a message filter_messages injects and leaves it for the next assembly only",
    requirements: ["0018442c", "62ac4caa", "61b94fc9", "6d8b1d0c", "8a28a42b", "16606350", "1ba43990", "d57ad351"],
    run: async (driver) => {
      for (const humanOn of SIDES) {
        const { human } = rolesFor(humanOn)
        const events: Array<unknown> = []
        let injected: Message | undefined
        const hooks = [
          defineHook({
            hook: "filter_messages",
            id: "inject_once",
            execute: async (state, messages) => {
              events.push(["filter", contents(messages)])
              if (injected === undefined) {
                injected = await state.injectMessage({ role: human, content: "from filter", metadata: { tag: "f" } })
                events.push(["read", (await state.getMessage(injected.id))?.content])
              }
              return messages
            },
          }),
          defineHook({
            hook: "prefilter_llm_history",
            id: "peek",
            execute: async (state, messages) => {
              events.push([
                "prefilter",
                contents(messages),
                contents(state.execution?.messageHistory ?? []).includes("from filter"),
              ])
              return messages
            },
          }),
          defineHook({
            hook: "before_create_message",
            id: "lifecycle_before",
            execute: async (_state, message) => {
              if (message.content === "from filter") events.push(["before", message.id])
              return message
            },
          }),
          defineHook({
            hook: "after_create_message",
            id: "lifecycle_after",
            execute: async (_state, message) => {
              if (message.content === "from filter") events.push(["after", message.id])
            },
          }),
        ]
        const provider = new ScriptedProvider([
          { toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
          { text: "done" },
        ])
        await using(
          driver,
          {
            provider,
            tools: noop,
            hooks,
            humanOn,
            prompt: { hooks: ["inject_once", "peek", "lifecycle_before", "lifecycle_after"] },
          },
          async (session, thread) => {
            await send(session, thread, "go")
            const id = injected?.id
            expect(events).toEqual([
              ["filter", ["go"]],
              ["before", id],
              ["after", id],
              ["read", "from filter"],
              ["prefilter", ["go"], true],
              ["filter", ["go", "from filter", null, "noop"]],
              ["prefilter", ["go", "from filter", null, "noop"], true],
            ])
            expect(provider.requests).toHaveLength(2)
            expect(provider.requests[0]?.messages).toEqual([system, { role: "user", content: "go" }])
            expect(provider.requests[1]?.messages.filter((m) => m.role === "system")).toEqual([system])
            expect(contents(history(provider.requests[1]))).toContain("from filter")
            expect((await session.messages(thread)).filter((m) => m.content === "from filter")).toHaveLength(1)
          },
        )
      }
    },
  },
  {
    name: "M6 gives a message prefilter_llm_history injects the same snapshot rule and never restarts the assembly",
    requirements: ["8233eb0b", "b7d299a8", "22cf59fa", "000bf2b7", "73bce32e", "e0078c2e", "d57ad351"],
    run: async (driver) => {
      for (const humanOn of SIDES) {
        const { human } = rolesFor(humanOn)
        const events: Array<unknown> = []
        let injected: Message | undefined
        const hooks = [
          defineHook({
            hook: "filter_messages",
            id: "count_filter",
            execute: async (_state, messages) => {
              events.push(["filter", contents(messages)])
              return messages
            },
          }),
          defineHook({
            hook: "prefilter_llm_history",
            id: "inject_late",
            execute: async (state, messages) => {
              events.push(["prefilter", contents(messages)])
              if (injected === undefined) {
                injected = await state.injectMessage({ role: human, content: "from prefilter" })
                events.push(["read", (await state.getMessage(injected.id))?.content])
              }
              return messages
            },
          }),
          defineHook({
            hook: "before_create_message",
            id: "creating",
            execute: async (_state, message) => {
              if (message.content === "from prefilter") events.push(["before", message.id])
              return message
            },
          }),
          defineHook({
            hook: "after_create_message",
            id: "created",
            execute: async (_state, message) => {
              if (message.content === "from prefilter") events.push(["after", message.id])
            },
          }),
        ]
        const tools = {
          observe: defineTool({
            description: "Look at the live history",
            execute: async (state: ThreadState) => {
              events.push(["tool", contents(state.execution?.messageHistory ?? [])])
              return ok("observed")
            },
          }),
        }
        const provider = new ScriptedProvider([
          { toolCalls: [{ id: "c1", name: "observe", arguments: {} }] },
          { text: "done" },
        ])
        await using(
          driver,
          {
            provider,
            tools,
            hooks,
            humanOn,
            prompt: { hooks: ["count_filter", "inject_late", "creating", "created"] },
          },
          async (session, thread) => {
            await send(session, thread, "go")
            expect(events).toEqual([
              ["filter", ["go"]],
              ["prefilter", ["go"]],
              ["before", injected?.id],
              ["after", injected?.id],
              ["read", "from prefilter"],
              ["tool", ["go", "from prefilter", null]],
              ["filter", ["go", "from prefilter", null, "observed"]],
              ["prefilter", ["go", "from prefilter", null, "observed"]],
            ])
            expect(provider.requests[0]?.messages).toEqual([system, { role: "user", content: "go" }])
            expect(provider.requests[1]?.messages.filter((m) => m.role === "system")).toEqual([system])
            expect(contents(history(provider.requests[1]))).toContain("from prefilter")
          },
        )
      }
    },
  },
  {
    name: "M7 interpolates first, then runs after_system_message, the snapshot, the filter, the transform, the prefilter, and the request",
    requirements: ["67885fd3", "aa659667", "88c209cc", "14d530a7", "29e645c3", "f88b47c5", "6d37745b", "b17aee6d"],
    run: async (driver) => {
      for (const humanOn of SIDES) {
        const { human } = rolesFor(humanOn)
        const order: Array<string> = []
        const seen: Array<unknown> = []
        const persisted: Array<unknown> = []
        let injected: Message | undefined
        const hooks = [
          defineHook({
            hook: "after_system_message",
            id: "replace_system",
            execute: async (state, systemMessage) => {
              order.push("after_system_message")
              seen.push(systemMessage)
              injected ??= await state.injectMessage({ role: human, content: "from system hook", silent: true })
              return "REPLACED"
            },
          }),
          defineHook({
            hook: "filter_messages",
            id: "see_filter",
            execute: async (state, messages) => {
              order.push("filter_messages")
              seen.push(messages.map((m) => [m.role, m.content, m.silent]))
              persisted.push(await state.getMessage(injected?.id ?? ""))
              return messages
            },
          }),
          defineHook({
            hook: "prefilter_llm_history",
            id: "final_array",
            execute: async (_state, messages) => {
              order.push("prefilter_llm_history")
              seen.push(messages.map((m: LLMMessage) => [m.role, m.content]))
              return [...messages, { role: "user", content: "final marker" }]
            },
          }),
        ]
        const prompt = definePrompt({
          name: "assistant",
          toolDescription: "Composes",
          model: "scripted",
          prompt: [
            { type: "text", content: "Base. " },
            { type: "include", prompt: "house_rules" },
            { type: "text", content: " Tone: " },
            { type: "env", property: "tone" },
          ],
          variables: [{ name: "tone", type: "text", required: true, description: "Voice" }],
          env: { tone: "warm" },
          hooks: ["replace_system", "see_filter", "final_array"],
        })
        const rules = definePrompt({
          name: "house_rules",
          toolDescription: "Rules",
          model: "scripted",
          prompt: "Be kind.",
        })
        const provider = new ScriptedProvider([
          () => {
            order.push("dispatch")
            return { text: "done" }
          },
        ])
        await using(driver, { provider, hooks, humanOn, prompt, prompts: [rules] }, async (session, thread) => {
          await send(session, thread, "go")
          expect(persisted).toEqual([injected])
          expect((await session.messages(thread)).find((m) => m.id === injected?.id)).toEqual(injected)
          expect(order).toEqual(["after_system_message", "filter_messages", "prefilter_llm_history", "dispatch"])
          expect(seen[0]).toBe("Base. Be kind. Tone: warm")
          expect(seen[1]).toEqual([
            [human, "go", false],
            [human, "from system hook", true],
          ])
          expect(seen[2]).toEqual([
            ["user", "go"],
            ["user", "from system hook"],
          ])
          expect(provider.requests[0]?.messages).toEqual([
            { role: "system", content: "REPLACED" },
            { role: "user", content: "go" },
            { role: "user", content: "from system hook" },
            { role: "user", content: "final marker" },
          ])
        })
      }
    },
  },
  {
    name: "M8 takes the snapshot and the live history from storage, so they hold a message that another handle stored",
    requirements: ["88c209cc", "41fe7364", "d492805f", "8cefb16e", "c4905fe6", "6d37745b"],
    run: async (driver) => {
      for (const humanOn of SIDES) {
        const { human } = rolesFor(humanOn)
        let elsewhere: ThreadState | undefined
        const seen: Array<unknown> = []
        const hooks = [
          defineHook({
            hook: "after_thread_created",
            id: "keep_handle",
            execute: async (state) => {
              elsewhere = state
            },
          }),
          defineHook({
            hook: "after_system_message",
            id: "write_elsewhere",
            execute: async (state) => {
              if (seen.length === 0) await elsewhere?.injectMessage({ role: human, content: "before the snapshot" })
              seen.push(["system hook", contents(state.execution?.messageHistory ?? [])])
              return null
            },
          }),
          defineHook({
            hook: "filter_messages",
            id: "look",
            execute: async (_state, messages) => {
              seen.push(["filter", contents(messages)])
              return messages
            },
          }),
        ]
        const tools = {
          observe: defineTool({
            description: "Write through the other handle, then read the live history",
            execute: async (state: ThreadState) => {
              await elsewhere?.injectMessage({ role: human, content: "during the tool" })
              seen.push(["tool", contents(state.execution?.messageHistory ?? [])])
              return ok("observed")
            },
          }),
        }
        const provider = new ScriptedProvider([
          { toolCalls: [{ id: "c1", name: "observe", arguments: {} }] },
          { text: "done" },
        ])
        await using(
          driver,
          {
            provider,
            tools,
            hooks,
            humanOn,
            agent: { hooks: ["keep_handle"] },
            prompt: { hooks: ["write_elsewhere", "look"] },
          },
          async (session, thread) => {
            await send(session, thread, "go")
            expect(seen).toEqual([
              ["system hook", ["go", "before the snapshot"]],
              ["filter", ["go", "before the snapshot"]],
              ["tool", ["go", "before the snapshot", null, "during the tool"]],
              ["system hook", ["go", "before the snapshot", null, "during the tool", "observed"]],
              ["filter", ["go", "before the snapshot", null, "during the tool", "observed"]],
            ])
            expect(contents(history(provider.requests[0]))).toEqual(["go", "before the snapshot"])
            expect(contents(history(provider.requests[1]))).toContain("during the tool")
          },
        )
      }
    },
  },
  {
    name: "M7b replaces the system message with any returned string, keeps it on null or undefined, and filters once per assembly",
    requirements: ["0018442c", "babeaaef", "bd9fdd64", "a237deef", "a72bbc07", "dfde10dc", "d492805f", "404eb18a"],
    run: async (driver) => {
      const systemOf = async (returns: Array<(system: string) => unknown>) => {
        const filters: Array<number> = []
        const prefilters: Array<unknown> = []
        const hooks = [
          ...returns.map((give, index) =>
            defineHook({
              hook: "after_system_message",
              id: `system_${index}`,
              execute: ((_state: ThreadState, system: string) => give(system)) as () => string,
            }),
          ),
          defineHook({
            hook: "filter_messages",
            id: "count",
            execute: async (_state, messages) => {
              filters.push(messages.length)
              return [...messages, { id: "synthetic", role: "user", content: "filtered", created_at: 0 }]
            },
          }),
          defineHook({
            hook: "prefilter_llm_history",
            id: "mark",
            execute: async (_state, messages) => {
              prefilters.push(messages.map((m) => [m.role, m.content, Array.isArray(m.tool_calls)]))
              return [...messages, { role: "user", content: "marked" }]
            },
          }),
        ]
        const provider = new ScriptedProvider([
          { toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
          { text: "done" },
        ])
        let systems: Array<unknown> = []
        await using(
          driver,
          {
            provider,
            tools: noop,
            hooks,
            prompt: { hooks: [...returns.map((_, index) => `system_${index}`), "count", "mark"] },
          },
          async (session, thread) => {
            await send(session, thread, "go")
            systems = provider.requests.map((request) => request.messages[0])
          },
        )
        expect(filters).toEqual([1, 3])
        expect(prefilters).toEqual([
          [
            ["user", "go", false],
            ["user", "filtered", false],
          ],
          [
            ["user", "go", false],
            ["assistant", null, true],
            ["tool", "noop", false],
            ["user", "filtered", false],
          ],
        ])
        expect(provider.requests.map((request) => history(request).slice(-2))).toEqual([
          [
            { role: "user", content: "filtered" },
            { role: "user", content: "marked" },
          ],
          [
            { role: "user", content: "filtered" },
            { role: "user", content: "marked" },
          ],
        ])
        return systems
      }
      const rendered = { role: "system", content: "You are a test assistant." }
      expect(await systemOf([() => ""])).toEqual([
        { role: "system", content: "" },
        { role: "system", content: "" },
      ])
      expect(await systemOf([() => null])).toEqual([rendered, rendered])
      expect(await systemOf([async () => undefined])).toEqual([rendered, rendered])
      expect(await systemOf([(system) => `${system} First.`, () => null])).toEqual([
        { role: "system", content: "You are a test assistant. First." },
        { role: "system", content: "You are a test assistant. First." },
      ])
    },
  },
]
