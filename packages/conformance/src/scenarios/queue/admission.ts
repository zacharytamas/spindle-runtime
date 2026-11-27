import { defineTool, type ThreadState, type ToolResult } from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import {
  attempt,
  gate,
  history,
  ok,
  quiet,
  runTurn,
  type Scenario,
  shape,
  statusOf,
  toolResults,
  using,
} from "../harness.ts"

import { acknowledge, echo, noop, ref } from "./fixtures.ts"

export const Q10: Scenario = {
  name: "Q10 lets queueTool and invokeTool reach a target an omitted or listing uses allows, and refuses an empty or other list",
  requirements: ["a403d2a5", "dc9a10a7", "a1ac0a36", "304b015d"],
  run: async (driver) => {
    const outcomes: Record<string, unknown> = {}
    const caller = (name: string, uses: ReadonlyArray<string> | undefined) =>
      defineTool({
        description: `Call echo as ${name}`,
        ...(uses === undefined ? {} : { uses: uses as Array<string> }),
        execute: async (state: ThreadState) => {
          let queued: string
          try {
            ;(state as ThreadState).queueTool("echo", { text: `queued by ${name}` })
            queued = "queued"
          } catch (error) {
            queued = `threw: ${(error as Error).message}`
          }
          const invoked: ToolResult = await (state as ThreadState).invokeTool("echo", { text: `invoked by ${name}` })
          outcomes[name] = { queued, invoked }
          return ok(name)
        },
      })
    const tools = {
      echo,
      noop,
      omitted: caller("omitted", undefined),
      empty: caller("empty", []),
      listed: caller("listed", ["echo"]),
      other: caller("other", ["noop"]),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: ["omitted", "empty", "listed", "other"].map((name) => ({ id: `c_${name}`, name, arguments: {} })),
      },
      { text: "done" },
    ])
    await using(driver, { provider, tools }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
      expect(outcomes).toEqual({
        omitted: { queued: "queued", invoked: { status: "success", result: "invoked by omitted" } },
        listed: { queued: "queued", invoked: { status: "success", result: "invoked by listed" } },
        empty: {
          queued: "threw: Tool empty does not list echo in uses",
          invoked: { status: "error", error: "Tool empty does not list echo in uses" },
        },
        other: {
          queued: "threw: Tool other does not list echo in uses",
          invoked: { status: "error", error: "Tool other does not list echo in uses" },
        },
      })
      const results = toolResults(await session.messages(thread)).map((m) => m.content)
      expect(results.filter((text) => text?.startsWith("queued by"))).toEqual(["queued by omitted", "queued by listed"])
    })
  },
}

export const Q15: Scenario = {
  name: "Q15 refuses a retries value that is not a whole number before it queues or runs anything",
  requirements: [],
  run: async (driver) => {
    const provider = new ScriptedProvider([])
    await using(driver, { provider }, async (session, thread) => {
      for (const retries of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])
        await expect(session.send(thread, "go", { retries })).rejects.toThrow(
          `retries must be a whole number of 0 or more, got ${retries}`,
        )
      expect(await session.messages(thread)).toEqual([])
      expect(await statusOf(session, thread)).toEqual({ state: "idle", since: 0, reason: null })
      expect(provider.requests).toHaveLength(0)
    })
  },
}

export const Q26: Scenario = {
  name: "Q26 commits nothing for a queueTool that throws, and runs each accepted call once when its arguments queue another",
  requirements: ["304b015d"],
  run: async (driver) => {
    const held = gate()
    const release = gate()
    const ran: Array<string> = []
    const work = defineTool({
      description: "Record the label",
      args: z.object({ label: z.string() }),
      execute: async (_state, { label }) => {
        ran.push(label)
        return ok(label)
      },
    })
    const provider = new ScriptedProvider([
      async () => {
        held.release()
        await release.opened
        return { text: "continue" }
      },
      { text: "done" },
      { text: "spare" },
    ])
    await using(driver, { provider, tools: { work } }, async (session, thread) => {
      const run = quiet(session.send(thread, "go"))
      await held.opened
      const state = await session.state(thread)
      const queue = (label: string, args: Record<string, unknown> = { label }) => {
        try {
          state.queueTool("work", args)
          return "accepted"
        } catch {
          return "threw"
        }
      }
      let reads = 0
      let inner = "not called"
      const outer = queue("outer", {
        get label() {
          reads += 1
          if (reads === 1) inner = queue("inner")
          return "outer"
        },
      })
      // A caller whose call threw queues the same work again, because a throw means that nothing was queued.
      const retried = {
        inner: inner === "threw" ? queue("inner") : inner,
        outer: outer === "threw" ? queue("outer") : outer,
      }
      const queued = (await session.inspect(thread)).queue.length
      release.release()
      expect(await run).toMatchObject({ status: "idle" })
      expect({ ran: [...ran].sort(), queued, reads, retried }).toEqual({
        ran: ["inner", "outer"],
        queued: 2,
        reads: 1,
        retried: { inner: "accepted", outer: "accepted" },
      })
    })
  },
}

export const Q27: Scenario = {
  name: "Q27 reads a getter on queued arguments once and runs the tool once with the value it returned",
  requirements: [],
  run: async (driver) => {
    const ran: Array<string> = []
    const work = defineTool({
      description: "Record the label",
      args: z.object({ label: z.string() }),
      execute: async (_state, { label }) => {
        ran.push(label)
        return ok(label)
      },
    })
    const provider = new ScriptedProvider([{ text: "saw it" }])
    await using(driver, { provider, tools: { work } }, async (session, thread) => {
      let reads = 0
      ;(await session.state(thread)).queueTool("work", {
        get label() {
          reads += 1
          return `read ${reads}`
        },
      })
      expect(await session.settled(thread)).toMatchObject({ status: "idle", steps: 1 })
      expect([reads, ran]).toEqual([1, ["read 1"]])
    })
  },
}

export const Q33: Scenario = {
  name: "Q33 sets an unreadable queue entry aside with its sequence and payload, and delivers the entries behind it once",
  requirements: ["f2cb78f1"],
  run: async (driver) => {
    const provider = new ScriptedProvider([acknowledge, acknowledge])
    await using(
      driver,
      { provider },
      async (session, thread) => {
        await session.queueRaw(thread, "message", "{")
        await session.queueRaw(thread, "tool", "null")
        const damaged = (await session.inspect(thread)).queue
        expect(damaged.map((entry) => [entry.kind, entry.payload, entry.failed])).toEqual([
          ["message", "{", false],
          ["tool", "null", false],
        ])
        const outcomes: Array<unknown> = []
        for (const text of ["one", "two"]) {
          const outcome = await session.send(thread, text)
          outcomes.push([outcome.status, outcome.reason])
        }
        expect({
          outcomes,
          asked: provider.requests.map((request) => history(request).at(-1)?.content),
          stored: shape(await session.messages(thread)).map((row) => row[1]),
          queue: (await session.inspect(thread)).queue,
        }).toEqual({
          outcomes: [
            ["idle", "stop_on_response"],
            ["idle", "stop_on_response"],
          ],
          asked: ["one", "two"],
          stored: ["one", "ack: one", "two", "ack: two"],
          queue: damaged.map((entry) => ({ ...entry, failed: true })),
        })
      },
      {},
    )
  },
}

export const Q42: Scenario = {
  name: "Q42 skips queued messages with malformed optional fields and keeps later chat history usable",
  requirements: ["f2cb78f1"],
  run: async (driver) => {
    const provider = new ScriptedProvider([acknowledge, acknowledge])
    await using(driver, { provider, prompt: { includeChat: true } }, async (session, thread) => {
      const seed = (content: string, fields = {}) =>
        session.queueRaw(thread, "message", JSON.stringify({ role: "user", content, ...fields }))
      await seed("before")
      for (const fields of [
        { attachments: "bad" },
        { attachments: [null] },
        { attachments: [{ ...ref, width: -1 }] },
        { metadata: [] },
        { silent: "yes" },
      ])
        await seed("damaged", fields)
      await seed("after")
      const damaged = (await session.inspect(thread)).queue.slice(1, -1)
      const first = await session.send(thread, "deliver")
      const later = await session.send(thread, "later")
      expect([first, later].map(({ status, reason }) => [status, reason])).toEqual([
        ["idle", "stop_on_response"],
        ["idle", "stop_on_response"],
      ])
      expect((await session.messages(thread)).map((message) => message.content)).toEqual([
        "before",
        "after",
        "deliver",
        "ack: before | after | deliver",
        "later",
        "ack: later",
      ])
      expect((await session.inspect(thread)).queue).toEqual(damaged.map((row) => ({ ...row, failed: true })))
    })
  },
}

export const Q37: Scenario = {
  name: "Q37 throws from queueTool when the arguments are null, and queues nothing",
  requirements: ["304b015d"],
  run: async (driver) => {
    const provider = new ScriptedProvider([{ text: "a reply that no refused call asks for" }])
    await using(driver, { provider, tools: { echo } }, async (session, thread) => {
      const state = await session.state(thread)
      const outcome = await attempt(() => state.queueTool("echo", null as never))
      const run = await session.settled(thread)
      const stored = (await session.messages(thread)).map((message) => message.tool_status ?? message.role)
      expect({ outcome, ran: run !== undefined, stored }).toEqual({
        outcome: "InvalidArguments",
        ran: false,
        stored: [],
      })
    })
  },
}

export const Q38: Scenario = {
  name: "Q38 lets a tool with a uses list leave out the arguments of queueTool",
  requirements: [],
  run: async (driver) => {
    const ran: Array<string> = []
    const target = defineTool({
      description: "Record the run",
      execute: async () => {
        ran.push("target")
        return ok("ran")
      },
    })
    const caller = defineTool({
      description: "Queue the target without arguments",
      uses: ["target"] as Array<string>,
      execute: async (state: ThreadState) => {
        // The package types the arguments as optional only on the ThreadState of a tool that lists its uses.
        ;(state as unknown as { queueTool: (name: string) => void }).queueTool("target")
        return ok("queued")
      },
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_caller", name: "caller", arguments: {} }] },
      { text: "done" },
    ])
    expect(await runTurn(driver, { provider, tools: { caller, target } }, "go")).toMatchObject({
      status: "idle",
      steps: 2,
    })
    expect(ran).toEqual(["target"])
  },
}
