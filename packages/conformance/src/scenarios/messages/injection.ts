import { defineHook, defineTool, type HookExecutionContext, type Message, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, ok, rolesFor, type Scenario, SIDES, sideOf, using } from "../harness.ts"

import { contents } from "./fixtures.ts"

export const M1: Scenario = {
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
          expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
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
}

export const M2: Scenario = {
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
          await session.send(thread, "go")
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
}

export const M3: Scenario = {
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
          await session.send(thread, "go")
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
}
