import { defineHook, defineTool, type ExecutionState, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import type { RuntimeSession } from "../../RuntimeDriver.ts"
import { type RecordedRequest, ScriptedProvider } from "../../ScriptedProvider.ts"
import {
  callsOf,
  gate,
  history,
  ok,
  quiet,
  rolesFor,
  type Scenario,
  SIDES,
  shape,
  sideOf,
  statusOf,
  using,
  waitForAdmission,
} from "../harness.ts"

import { acknowledge, echo, noop, ref } from "./fixtures.ts"

export const Q03: Scenario = {
  name: "Q03 takes two sends to one thread in one execution, and a message queued as the run settles still reaches it",
  requirements: ["cca93b6d", "0953e887", "e28dedf2", "6e443a4c", "804046ad", "db1fad8a", "3faec548", "f448a4e6"],
  run: async (driver) => {
    const held = gate()
    const release = gate()
    const provider = new ScriptedProvider([
      async () => {
        held.release()
        await release.opened
        return { toolCalls: [{ id: "c_noop", name: "noop", arguments: {} }] }
      },
      acknowledge,
    ])
    await using(driver, { provider, tools: { noop } }, async (session, thread) => {
      const alpha = session.send(thread, "alpha")
      await held.opened
      const beta = session.send(thread, "beta")
      expect(await statusOf(session, thread)).toMatchObject({ state: "running", reason: null })
      release.release()
      const [first, second] = await Promise.all([alpha, beta])
      expect([first, second]).toEqual([first, first])
      expect(first).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
      expect(provider.requests).toHaveLength(2)
      expect(history(provider.requests[0]).map(sideOf)).toEqual([["user", "alpha"]])
      expect(history(provider.requests[1]).map(sideOf)).toEqual([
        ["user", "alpha"],
        ["assistant", null, ["c_noop"]],
        ["tool", "c_noop"],
        ["user", "beta"],
      ])
      expect(shape(await session.messages(thread)).filter((row) => row[0] === "user")).toEqual([
        ["user", "alpha"],
        ["user", "beta"],
      ])
    })
    // The peer queues while the final response's create hook runs, after the run's last drain and before it settles.
    let peer: RuntimeSession | undefined
    let threadId = ""
    const late = defineHook({
      hook: "after_create_message",
      id: "late",
      execute: async (_state, message) => {
        if (message.content === "ack: first" && peer !== undefined)
          await (await peer.state(threadId)).queueMessage({ role: "user", content: "late" })
      },
    })
    const settling = new ScriptedProvider([acknowledge, acknowledge])
    await using(driver, { provider: settling, hooks: [late], prompt: { hooks: ["late"] } }, async (session, thread) => {
      threadId = thread
      peer = await session.peer()
      try {
        expect(await session.send(thread, "first")).toMatchObject({ status: "idle", steps: 2 })
        expect(settling.requests.map((request) => history(request).at(-1)?.content)).toEqual(["first", "late"])
        expect(shape(await session.messages(thread)).map((row) => row[1])).toEqual([
          "first",
          "ack: first",
          "late",
          "ack: late",
        ])
      } finally {
        await peer.close()
      }
    })
  },
}

export const Q04: Scenario = {
  name: "Q04 runs two threads at the same time, each with only its own history",
  requirements: ["0953e887"],
  run: async (driver) => {
    const entered = [gate(), gate()]
    const release = gate()
    let arrivals = 0
    const step = async (request: RecordedRequest) => {
      entered[arrivals++]?.release()
      await release.opened
      return acknowledge(request)
    }
    const provider = new ScriptedProvider([step, step])
    await using(driver, { provider }, async (session, one) => {
      const two = await session.createThread("assistant")
      const runs = [session.send(one, "one"), session.send(two, "two")]
      await Promise.all(entered.map((entry) => entry.opened))
      expect([await statusOf(session, one), await statusOf(session, two)]).toMatchObject([
        { state: "running" },
        { state: "running" },
      ])
      release.release()
      expect(await Promise.all(runs)).toMatchObject([{ status: "idle" }, { status: "idle" }])
      expect(provider.requests.map((request) => history(request).map(sideOf)).sort()).toEqual([
        [["user", "one"]],
        [["user", "two"]],
      ])
      expect(shape(await session.messages(one))).toEqual([
        ["user", "one"],
        ["assistant", "ack: one"],
      ])
    })
  },
}

export const Q05: Scenario = {
  name: "Q05 settles a turn idle for the human, reads running inside it, and resumes with both earlier records",
  requirements: ["6e443a4c", "176f7205", "9a66b438", "ce0b6d35", "a46f561c", "b9a39da8", "b8f7cd7e", "7e4cfd7a"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human, model } = rolesFor(humanOn)
      const inside: Array<unknown> = []
      const probe = defineTool({
        description: "Read the run status",
        execute: async (state: ThreadState) => {
          inside.push(await state.status())
          return ok("read")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_probe", name: "probe", arguments: {} }] },
        acknowledge,
        acknowledge,
      ])
      await using(
        driver,
        { provider, humanOn, tools: { probe }, prompt: { includeChat: true, includePastTools: true } },
        async (session, thread) => {
          expect(await statusOf(session, thread)).toEqual({ state: "idle", since: 0, reason: null })
          expect(await session.send(thread, "first")).toMatchObject({ status: "idle", reason: "stop_on_response" })
          expect(inside).toEqual([{ state: "running", since: expect.any(Number), reason: null }])
          const settled = await statusOf(session, thread)
          expect(settled).toMatchObject({ state: "idle", reason: "stop_on_response" })
          expect(settled.since).toBeGreaterThan((inside[0] as { since: number }).since)
          expect(await session.send(thread, "second")).toMatchObject({ status: "idle", steps: 1 })
          expect(history(provider.requests[2]).map(sideOf)).toEqual([
            ["user", "first"],
            ["assistant", null, ["c_probe"]],
            ["tool", "c_probe"],
            ["assistant", "ack: ", []],
            ["user", "second"],
          ])
          expect(shape(await session.messages(thread)).map((row) => row[0])).toEqual([
            human,
            model,
            "tool",
            model,
            human,
            model,
          ])
        },
      )
    }
  },
}

export const Q06: Scenario = {
  name: "Q06 starts a turn from a message queued to an idle thread, with its perspective and payload, and parks for the human",
  requirements: ["d0f4d8de", "66bd1ce0", "7273c803", "b7c8285e", "37cadafc", "176f7205"],
  run: async (driver) => {
    for (const humanOn of SIDES) {
      const { human, model } = rolesFor(humanOn)
      const provider = new ScriptedProvider([acknowledge])
      await using(driver, { provider, humanOn }, async (session, thread) => {
        const state = await session.state(thread)
        const queued = state.queueMessage({
          role: human,
          content: "queued",
          metadata: { source: "test" },
          silent: true,
          attachments: [ref],
        })
        expect(await queued).toBeUndefined()
        expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
        const stored = await session.messages(thread)
        expect(stored[0]).toMatchObject({
          role: human,
          content: "queued",
          metadata: { source: "test" },
          silent: true,
          attachments: [ref],
          status: "completed",
        })
        expect((await state.getMessages({ order: "asc" })).messages.map((message) => message.content)).toEqual([
          "ack: queued\n[Attachment a.txt (text/plain) at /notes/a.txt]",
        ])
        expect(history(provider.requests[0]).map(sideOf)).toEqual([
          ["user", "queued\n[Attachment a.txt (text/plain) at /notes/a.txt]"],
        ])
        // A message in the model side's own perspective is one the human acts on, so the run parks for the human.
        await state.queueMessage({ role: model, content: "for the human" })
        expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "awaiting_human", steps: 0 })
        expect(provider.requests).toHaveLength(1)
        expect((await session.messages(thread)).at(-1)).toMatchObject({ role: model, content: "for the human" })
      })
    }
  },
}

export const Q07: Scenario = {
  name: "Q07 holds messages queued during a request for the next request, in order, in the same run",
  requirements: ["0bf4f9af", "804046ad", "129b4a0c", "5012a6bc", "f2cb78f1", "f448a4e6"],
  run: async (driver) => {
    const held = gate()
    const release = gate()
    const provider = new ScriptedProvider([
      async () => {
        held.release()
        await release.opened
        return { toolCalls: [{ id: "c_noop", name: "noop", arguments: {} }] }
      },
      acknowledge,
    ])
    await using(driver, { provider, tools: { noop } }, async (session, thread) => {
      const run = session.send(thread, "go")
      await held.opened
      const before = await statusOf(session, thread)
      const state = await session.state(thread)
      await state.queueMessage({ role: "user", content: "x" })
      await state.queueMessage({ role: "user", content: "y" })
      expect(await statusOf(session, thread)).toEqual(before)
      release.release()
      expect(await run).toMatchObject({ status: "idle", steps: 2 })
      expect(history(provider.requests[0]).map(sideOf)).toEqual([["user", "go"]])
      expect(history(provider.requests[1]).map(sideOf)).toEqual([
        ["user", "go"],
        ["assistant", null, ["c_noop"]],
        ["tool", "c_noop"],
        ["user", "x"],
        ["user", "y"],
      ])
      expect((await session.messages(thread)).at(-1)?.content).toBe("ack: x | y")
    })
  },
}

export const Q08: Scenario = {
  name: "Q08 runs a tool queued to an idle thread with no model call asking for it, then the model sees the call and result",
  requirements: ["d2739fbc", "ff27b66e", "304b015d"],
  run: async (driver) => {
    const explode = defineTool({
      description: "Throw",
      execute: async () => {
        throw new Error("queued tool failed")
      },
    })
    const provider = new ScriptedProvider([{ text: "saw it" }, { text: "saw the error" }])
    await using(driver, { provider, tools: { echo, explode } }, async (session, thread) => {
      const state = await session.state(thread)
      expect(state.queueTool("echo", { text: "hi" })).toBeUndefined()
      expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      const stored = await session.messages(thread)
      const [call] = callsOf(stored[0])
      expect(stored[0]).toMatchObject({
        role: "assistant",
        content: null,
        prompt: "assistant",
        metadata: { queued: true },
      })
      expect(call).toEqual({
        id: expect.any(String),
        type: "function",
        function: { name: "echo", arguments: '{"text":"hi"}' },
      })
      expect(stored[1]).toMatchObject({
        role: "tool",
        name: "echo",
        tool_call_id: call?.id,
        tool_status: "success",
        content: "hi",
      })
      expect(history(provider.requests[0]).map(sideOf)).toEqual([
        ["assistant", null, [call?.id]],
        ["tool", call?.id],
      ])
      state.queueTool("explode", {})
      expect(await session.settled(thread)).toMatchObject({ status: "idle", steps: 1 })
      expect((await session.messages(thread)).slice(-2).map((m) => [m.role, m.tool_status, m.content])).toEqual([
        ["tool", "error", "Tool explode threw: queued tool failed"],
        ["assistant", null, "saw the error"],
      ])
    })
  },
}

export const Q09: Scenario = {
  name: "Q09 drains a queued message, a queued tool, and another message in arrival order before the next request",
  requirements: ["109134a1", "ff27b66e", "129b4a0c", "5012a6bc"],
  run: async (driver) => {
    const held = gate()
    const release = gate()
    const seen: Array<Array<unknown>> = []
    const look = defineTool({
      description: "Read the live history",
      execute: async (state: ThreadState) => {
        seen.push((state.execution?.messageHistory ?? []).map((message) => message.content))
        return ok("looked")
      },
    })
    const slow = defineTool({
      description: "Wait",
      execute: async () => {
        held.release()
        await release.opened
        return ok("slow")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_slow", name: "slow", arguments: {} }] }, acknowledge])
    await using(driver, { provider, tools: { slow, look } }, async (session, thread) => {
      const run = session.send(thread, "go")
      await held.opened
      const state = await session.state(thread)
      await state.queueMessage({ role: "user", content: "A" })
      state.queueTool("look", {})
      await state.queueMessage({ role: "user", content: "B" })
      release.release()
      expect(await run).toMatchObject({ status: "idle", steps: 2 })
      const second = history(provider.requests[1]).map(sideOf)
      const queuedCall = callsOf((await session.messages(thread)).find((m) => m.metadata?.queued === true))[0]?.id
      expect(second).toEqual([
        ["user", "go"],
        ["assistant", null, ["c_slow"]],
        ["tool", "c_slow"],
        ["user", "A"],
        ["assistant", null, [queuedCall]],
        ["tool", queuedCall],
        ["user", "B"],
      ])
      expect(seen).toEqual([["go", null, "slow", "A", null]])
    })
  },
}

export const Q40: Scenario = {
  name: "Q40 puts every entry that one drain delivers at the start of a turn into the first request after it",
  requirements: ["109134a1", "5012a6bc"],
  run: async (driver) => {
    const asked: Record<string, unknown> = {}
    for (const first of ["message", "tool"] as const) {
      const held = gate()
      const release = gate()
      let execution: ExecutionState | null = null
      const hold = defineTool({
        description: "Wait for the test",
        execute: async (state: ThreadState) => {
          execution = state.execution
          held.release()
          await release.opened
          return ok("held")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_hold", name: "hold", arguments: {} }] },
        acknowledge,
      ])
      await using(driver, { provider, tools: { hold, echo } }, async (session, thread) => {
        const run = quiet(session.send(thread, "go"))
        await held.opened
        const state = await session.state(thread)
        if (first === "message") await state.queueMessage({ role: "user", content: "A" })
        else state.queueTool("echo", { text: "queued" })
        const waiting = quiet(session.send(thread, "B"))
        await waitForAdmission(async () => (await session.inspect(thread)).queue.length >= 2)
        ;(execution as ExecutionState | null)?.stop()
        release.release()
        expect(await run).toMatchObject({ status: "idle", reason: "aborted" })
        expect(await waiting).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
        const queuedCall = callsOf((await session.messages(thread)).find((m) => m.metadata?.queued === true))[0]?.id
        asked[first] = history(provider.requests[1])
          .map(sideOf)
          .slice(first === "message" ? -2 : -3)
          .map((row) =>
            queuedCall !== undefined && (row[1] === queuedCall || row[2]?.[0] === queuedCall)
              ? [row[0], "the queued call"]
              : row.slice(0, 2),
          )
      })
    }
    expect(asked).toEqual({
      message: [
        ["user", "A"],
        ["user", "B"],
      ],
      tool: [
        ["assistant", "the queued call"],
        ["tool", "the queued call"],
        ["user", "B"],
      ],
    })
  },
}
