import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import {
  attempt,
  firstToolResult,
  gate,
  history,
  ok,
  quiet,
  type Scenario,
  sideOf,
  stubTool,
  toolResults,
  usingPeer,
} from "../harness.ts"

import { contents, noop } from "./fixtures.ts"

export const O13: Scenario = {
  name: "O13 records the flow of each message an execution writes and the caller of each tool result",
  requirements: [],
  run: async (driver) => {
    let flowSeen = ""
    const look = defineTool({
      description: "Read the flow id",
      execute: async (state: ThreadState) => {
        flowSeen = state.execution?.flowId ?? ""
        return ok("looked")
      },
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_look", name: "look", arguments: {} }] },
      { text: "done" },
    ])
    await usingPeer(driver, { provider, tools: { look } }, async (session, thread, peer) => {
      await session.seed(thread, [{ role: "user", content: "seeded" }])
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
      const rows = (await peer.inspect(thread)).messages
      const caller = rows.find((row) => row.role === "assistant" && row.content === null)
      expect(flowSeen).not.toBe("")
      // The human's message is left out: the decision does not say whether its delivery counts as a write of the flow.
      const written = rows.filter((row) => row.content !== "go")
      expect(written.map((row) => [row.role, row.content, row.flowId, row.callerSeq])).toEqual([
        ["user", "seeded", null, null],
        ["assistant", null, flowSeen, null],
        ["tool", "looked", flowSeen, caller?.seq],
        ["assistant", "done", flowSeen, null],
      ])
    })
  },
}

export const O14: Scenario = {
  name: "O14 closes the open call of a lost execution although a hook set the caller's prompt to null",
  requirements: ["286367b3"],
  run: async (driver) => {
    const entered = gate()
    const leave = gate()
    const hide = defineHook({
      hook: "before_create_message",
      id: "hide",
      execute: async (_state, message) => (message.tool_calls === null ? message : { ...message, prompt: null }),
    })
    const hold = defineTool({
      description: "Wait for the test",
      execute: async () => {
        entered.release()
        await leave.opened
        return ok("returned")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ id: "y", name: "hold", arguments: {} }] }])
    await usingPeer(
      driver,
      { provider, tools: { hold }, hooks: [hide], prompt: { hooks: ["hide"] } },
      async (session, thread, peer) => {
        const run = quiet(session.send(thread, "A")).catch(() => undefined)
        await entered.opened
        try {
          const before = await peer.messages(thread)
          expect(before.map((message) => [message.role, message.prompt])).toEqual([
            ["user", null],
            ["assistant", null],
          ])
          await peer.forceRecover(thread)
          expect((await peer.messages(thread)).map((m) => [m.role, m.tool_call_id, m.tool_status])).toEqual([
            ["user", null, null],
            ["assistant", null, null],
            ["tool", "y", "error"],
          ])
        } finally {
          leave.release()
        }
        await run
      },
    )
  },
}

export const O15: Scenario = {
  name: "O15 stores exactly one result for a completed call whose id holds a NUL character",
  requirements: ["41278e5e"],
  run: async (driver) => {
    const id = "a\u0000b"
    const once = stubTool("Run once", "once")
    const provider = new ScriptedProvider([{ toolCalls: [{ id, name: "once", arguments: {} }] }, { text: "done" }])
    await usingPeer(driver, { provider, tools: { once } }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
      const results = toolResults(await session.messages(thread))
      expect(results.map((m) => [m.tool_call_id, m.tool_status, m.content])).toEqual([[id, "success", "once"]])
      expect(history(provider.requests[1]).map(sideOf)).toEqual([
        ["user", "go"],
        ["assistant", null, [id]],
        ["tool", id],
      ])
    })
  },
}

export const O16: Scenario = {
  name: "O16 gives two open callers that reuse one call id a closing result each, and the next request pairs each with its caller",
  requirements: ["41278e5e"],
  run: async (driver) => {
    const entered = gate()
    const leave = gate()
    const first = stubTool("Answer the first call", "first answer")
    const second = defineTool({
      description: "Delete the first call's result, then wait",
      execute: async (state: ThreadState) => {
        const earlier = firstToolResult((await state.getMessages({ order: "asc" })).messages)
        await state.deleteMessage(earlier?.id ?? "")
        entered.release()
        await leave.opened
        return ok("second answer")
      },
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "dup", name: "first", arguments: {} }] },
      { toolCalls: [{ id: "dup", name: "second", arguments: {} }] },
      { text: "after the recovery" },
    ])
    await usingPeer(
      driver,
      { provider, tools: { first, second }, prompt: { includeChat: true, includePastTools: true } },
      async (session, thread, peer) => {
        const run = quiet(session.send(thread, "go")).catch(() => undefined)
        await entered.opened
        try {
          await peer.forceRecover(thread)
        } finally {
          leave.release()
        }
        await run
        const rows = (await peer.inspect(thread)).messages
        const callers = rows.filter((row) => row.role === "assistant")
        expect(toolResults(rows).map((row) => row.callerSeq)).toEqual(callers.map((row) => row.seq))
        expect(await peer.send(thread, "again")).toMatchObject({ status: "idle", reason: "stop_on_response" })
        expect(history(provider.requests[2]).map(sideOf)).toEqual([
          ["user", "go"],
          ["assistant", null, ["dup"]],
          ["tool", "dup"],
          ["assistant", null, ["dup"]],
          ["tool", "dup"],
          ["user", "again"],
        ])
      },
    )
  },
}

export const O17: Scenario = {
  name: "O17 refuses to delete a message that holds an open call of a running execution, from the tool and from another session",
  requirements: ["41278e5e"],
  run: async (driver) => {
    const entered = gate()
    const leave = gate()
    let caller = ""
    let fromTool = ""
    const hold = defineTool({
      description: "Try to delete the message that holds this call, then wait",
      execute: async (state: ThreadState) => {
        caller = state.execution?.messageHistory.findLast((message) => message.tool_calls !== null)?.id ?? ""
        fromTool = await attempt(() => state.deleteMessage(caller))
        entered.release()
        await leave.opened
        return ok("the effect happened")
      },
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_hold", name: "hold", arguments: {} }] },
      { text: "done" },
    ])
    await usingPeer(driver, { provider, tools: { hold } }, async (session, thread, peer) => {
      const run = quiet(session.send(thread, "go"))
      await entered.opened
      let fromPeer = ""
      try {
        fromPeer = await attempt(async () => (await peer.state(thread)).deleteMessage(caller))
      } finally {
        leave.release()
      }
      expect(await run).toMatchObject({ status: "idle", steps: 2 })
      expect({ fromTool, fromPeer }).toEqual({ fromTool: "CallerHasOpenCalls", fromPeer: "CallerHasOpenCalls" })
      expect((await session.messages(thread)).map((m) => [m.role, m.tool_call_id, m.tool_status])).toEqual([
        ["user", null, null],
        ["assistant", null, null],
        ["tool", "c_hold", "success"],
        ["assistant", null, null],
      ])
    })
  },
}

export const O18: Scenario = {
  name: "O18 deletes a message whose calls all have results, with those results, once its execution has settled",
  requirements: [],
  run: async (driver) => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_noop", name: "noop", arguments: {} }] },
      { text: "done" },
    ])
    await usingPeer(driver, { provider, tools: { noop } }, async (session, thread, peer) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
      const caller = (await session.messages(thread)).find((message) => message.tool_calls !== null)
      expect(await attempt(async () => (await peer.state(thread)).deleteMessage(caller?.id ?? ""))).toBe("done")
      expect(await contents(session, thread)).toEqual(["go", "done"])
    })
  },
}
