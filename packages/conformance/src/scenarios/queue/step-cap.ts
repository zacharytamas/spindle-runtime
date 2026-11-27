import { defineHook, defineTool } from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { gate, ok, quiet, type Scenario, shape, using } from "../harness.ts"

import { acknowledge, noop } from "./fixtures.ts"

export const Q23: Scenario = {
  name: "Q23 ends an execution at the step cap although a hook queues a message on every response, and the next send delivers it",
  requirements: ["1a0354bc"],
  run: async (driver) => {
    let queued = 0
    const again = defineHook({
      hook: "after_create_message",
      id: "again",
      execute: async (state, message) => {
        if (message.role !== "assistant") return
        queued += 1
        await state.queueMessage({ role: "user", content: `again ${queued}` })
      },
    })
    const provider = new ScriptedProvider([acknowledge, acknowledge, acknowledge, acknowledge])
    await using(
      driver,
      // includeChat keeps the first turn in the second request, so the reply names every message the model was asked.
      { provider, hooks: [again], prompt: { hooks: ["again"], includeChat: true } },
      async (session, thread) => {
        const first = await session.send(thread, "go", { stepCap: 1 })
        const afterFirst = await session.inspect(thread)
        expect({
          requests: provider.requests.length,
          outcome: [first.status, first.reason, first.steps],
          status: [afterFirst.status.state, afterFirst.status.reason],
          claim: afterFirst.claim,
          queue: afterFirst.queue.map((entry) => (JSON.parse(entry.payload) as { content?: string }).content),
        }).toEqual({
          requests: 1,
          outcome: ["idle", "max_total_steps", 1],
          status: ["idle", "max_total_steps"],
          claim: null,
          queue: ["again 1"],
        })
        const second = await session.send(thread, "next", { stepCap: 1 })
        expect([provider.requests.length, second.status, second.reason, second.steps]).toEqual([
          2,
          "idle",
          "max_total_steps",
          1,
        ])
        expect(shape(await session.messages(thread)).map((row) => row[1])).toEqual([
          "go",
          "ack: go",
          "again 1",
          "next",
          "ack: again 1 | next",
        ])
        expect((await session.inspect(thread)).queue).toHaveLength(1)
      },
      {},
    )
  },
}

export const Q24: Scenario = {
  name: "Q24 goes on into queued work while an execution is below the step cap",
  requirements: [],
  run: async (driver) => {
    let queued = false
    const once = defineHook({
      hook: "after_create_message",
      id: "once",
      execute: async (state, message) => {
        if (message.role !== "assistant" || queued) return
        queued = true
        await state.queueMessage({ role: "user", content: "queued by the hook" })
      },
    })
    const provider = new ScriptedProvider([acknowledge, acknowledge])
    await using(
      driver,
      { provider, hooks: [once], prompt: { hooks: ["once"] } },
      async (session, thread) => {
        expect(await session.send(thread, "go", { stepCap: 3 })).toMatchObject({
          status: "idle",
          reason: "stop_on_response",
          steps: 2,
        })
        expect((await session.messages(thread)).at(-1)?.content).toBe("ack: queued by the hook")
        expect((await session.inspect(thread)).queue).toEqual([])
      },
      {},
    )
  },
}

export const Q25: Scenario = {
  name: "Q25 leaves work queued when the step cap ends an execution, and the next send delivers it once and in order",
  requirements: ["3b19a524"],
  run: async (driver) => {
    const held = gate()
    const release = gate()
    const ran: Array<string> = []
    const tracked = defineTool({
      description: "Record each run",
      args: z.object({ text: z.string() }),
      execute: async (_state, { text }) => {
        ran.push(text)
        return ok(text)
      },
    })
    const provider = new ScriptedProvider([
      async () => {
        held.release()
        await release.opened
        return { toolCalls: [{ id: "c_noop", name: "noop", arguments: {} }] }
      },
      { text: "after the next send" },
    ])
    await using(
      driver,
      { provider, tools: { noop, tracked } },
      async (session, thread) => {
        const peer = await session.peer()
        try {
          const run = quiet(session.send(thread, "go", { stepCap: 1 }))
          await held.opened
          const state = await peer.state(thread)
          state.queueTool("tracked", { text: "queued at the cap" })
          await state.queueMessage({ role: "user", content: "late" })
          release.release()
          expect(await run).toMatchObject({ status: "idle", reason: "max_total_steps", steps: 1 })
          const capped = await peer.inspect(thread)
          expect([capped.status.state, capped.status.reason, capped.claim, capped.queue.length]).toEqual([
            "idle",
            "max_total_steps",
            null,
            2,
          ])
          expect([ran, provider.requests.length]).toEqual([[], 1])
          expect(await session.send(thread, "next")).toMatchObject({ status: "idle", reason: "stop_on_response" })
          expect(ran).toEqual(["queued at the cap"])
          expect((await session.messages(thread)).map((m) => m.tool_status ?? m.content)).toEqual([
            "go",
            null,
            "success",
            null,
            "success",
            "late",
            "next",
            "after the next send",
          ])
          expect((await peer.inspect(thread)).queue).toEqual([])
        } finally {
          await peer.close()
        }
      },
      {},
    )
  },
}

export const Q43: Scenario = {
  name: "Q43 gives a send waiting at the step cap a new execution with its own cap",
  requirements: ["3b19a524"],
  run: async (driver) => {
    const held = gate()
    const release = gate()
    const provider = new ScriptedProvider([
      async () => {
        held.release()
        await release.opened
        return { text: "first reply" }
      },
      { toolCalls: [{ id: "c_one", name: "noop", arguments: {} }] },
      { toolCalls: [{ id: "c_two", name: "noop", arguments: {} }] },
    ])
    await using(driver, { provider, tools: { noop } }, async (session, thread) => {
      const peer = await session.peer()
      try {
        const first = quiet(session.send(thread, "first", { stepCap: 1 }))
        await held.opened
        const second = quiet(peer.send(thread, "second", { stepCap: 2 }))
        await expect.poll(async () => (await peer.inspect(thread)).queue.length).toBe(1)
        release.release()
        expect(await first).toMatchObject({ status: "idle", reason: "max_total_steps", steps: 1 })
        expect(await second).toMatchObject({ status: "idle", reason: "max_total_steps", steps: 2 })
        const stored = await peer.inspect(thread)
        const replies = stored.messages.filter((row) => row.role === "assistant")
        const firstFlow = replies[0]?.flowId
        const secondFlow = replies[1]?.flowId
        expect(firstFlow).toEqual(expect.any(String))
        expect(secondFlow).toEqual(expect.any(String))
        expect(secondFlow).not.toBe(firstFlow)
        expect(replies.map((row) => row.flowId)).toEqual([firstFlow, secondFlow, secondFlow])
        expect(stored.messages.filter((row) => row.role === "user").map((row) => row.content)).toEqual([
          "first",
          "second",
        ])
        expect(stored.queue).toEqual([])
      } finally {
        release.release()
        await peer.close()
      }
    })
  },
}
