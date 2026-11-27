import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { history, ok, rolesFor, type Scenario, SIDES, using } from "../harness.ts"

import { contents } from "./fixtures.ts"

export const M8: Scenario = {
  name: "M8 takes the snapshot and the live history from storage, so they hold a message that another handle stored",
  requirements: ["88c209cc", "41fe7364", "d492805f", "8cefb16e", "c4905fe6", "6d37745b"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human } = rolesFor(humanOn)
      let elsewhere: ThreadState | undefined
      const seen: Array<unknown> = []
      const hooks = [
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
          prompt: { hooks: ["write_elsewhere", "look"] },
        },
        async (session, thread) => {
          elsewhere = await session.state(thread)
          await session.send(thread, "go")
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
}

export const M8b: Scenario = {
  name: "M8b takes the snapshot and the live history from storage, so they hold a message that another connection stored",
  requirements: ["41fe7364", "6d37745b", "8254ece3", "c4905fe6"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human } = rolesFor(humanOn)
      let writeElsewhere = async (_content: string) => {}
      const seen: Array<unknown> = []
      const hooks = [
        defineHook({
          hook: "after_system_message",
          id: "write_elsewhere",
          execute: async () => {
            if (seen.length === 0) await writeElsewhere("before the snapshot")
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
          description: "Write on another connection, then read the live history",
          execute: async (state: ThreadState) => {
            await writeElsewhere("during the tool")
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
        { provider, tools, hooks, humanOn, prompt: { hooks: ["write_elsewhere", "look"] } },
        async (session, thread) => {
          writeElsewhere = (content) => session.seed(thread, [{ role: human, content }])
          await session.send(thread, "go")
          expect(seen).toEqual([
            ["filter", ["go", "before the snapshot"]],
            ["tool", ["go", "before the snapshot", null, "during the tool"]],
            ["filter", ["go", "before the snapshot", null, "during the tool", "observed"]],
          ])
          expect(contents(history(provider.requests[0]))).toEqual(["go", "before the snapshot"])
          expect(contents(history(provider.requests[1]))).toContain("during the tool")
        },
      )
    }
  },
}

export const M8c: Scenario = {
  name: "M8c takes the snapshot and the live history from storage, so they hold another handle's edit of a message the run already read",
  requirements: ["41fe7364", "6d37745b", "8254ece3", "c4905fe6"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      let elsewhere: ThreadState | undefined
      const seen: Array<unknown> = []
      const edit = async (content: string) => {
        const first = (await elsewhere?.getMessages({ order: "asc" }))?.messages[0]
        await elsewhere?.updateMessage(first?.id ?? "", { content })
      }
      const hooks = [
        defineHook({
          hook: "after_system_message",
          id: "edit_elsewhere",
          execute: async (state) => {
            if (state.execution?.stepCount === 1) await edit("go, edited before the snapshot")
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
          description: "Edit through the other handle, then read the live history",
          execute: async (state: ThreadState) => {
            seen.push(["tool", contents(state.execution?.messageHistory ?? [])])
            await edit("go, edited during the tool")
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
          prompt: { hooks: ["edit_elsewhere", "look"] },
        },
        async (session, thread) => {
          elsewhere = await session.state(thread)
          await session.send(thread, "go")
          expect(seen).toEqual([
            ["filter", ["go"]],
            ["tool", ["go", null]],
            ["tool", ["go, edited during the tool", null]],
            ["filter", ["go, edited before the snapshot", null, "observed"]],
          ])
          expect(contents(history(provider.requests[1]))).toContain("go, edited before the snapshot")
        },
      )
    }
  },
}

export const M8d: Scenario = {
  name: "M8d takes the snapshot and the live history from storage, so they lose a message the run already read and another handle deleted",
  requirements: ["41fe7364", "6d37745b", "8254ece3", "c4905fe6"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human } = rolesFor(humanOn)
      let elsewhere: ThreadState | undefined
      const seen: Array<unknown> = []
      const remove = async (content: string) => {
        const found = (await elsewhere?.getMessages({ order: "asc" }))?.messages.find((m) => m.content === content)
        await elsewhere?.deleteMessage(found?.id ?? "")
      }
      const hooks = [
        defineHook({
          hook: "after_system_message",
          id: "delete_elsewhere",
          execute: async (state) => {
            if (state.execution?.stepCount === 1) await remove("deleted before the snapshot")
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
          description: "Delete through the other handle, then read the live history",
          execute: async (state: ThreadState) => {
            await remove("deleted during the tool")
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
          prompt: { hooks: ["delete_elsewhere", "look"], includeChat: true },
        },
        async (session, thread) => {
          elsewhere = await session.state(thread)
          await session.seed(thread, [
            { role: human, content: "deleted during the tool" },
            { role: human, content: "deleted before the snapshot" },
          ])
          await session.send(thread, "go")
          expect(seen).toEqual([
            ["filter", ["deleted during the tool", "deleted before the snapshot", "go"]],
            ["tool", ["deleted before the snapshot", "go", null]],
            ["filter", ["go", null, "observed"]],
          ])
          expect(contents(history(provider.requests[0]))).toContain("deleted before the snapshot")
          expect(contents(history(provider.requests[1]))).toEqual(["go", null, "observed"])
        },
      )
    }
  },
}
