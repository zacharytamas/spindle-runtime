import { defineHook, defineTool, ProviderError, type ThreadState, type ThreadStatus } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../ScriptedProvider.ts"
import { ok, type Scenario, statusOf, stubTool, using } from "./harness.ts"

export const runStatusScenarios: ReadonlyArray<Scenario> = [
  {
    name: "R15 reads the run status at rest, inside a run, after success and failure, and from another session",
    requirements: ["ff3ed10f", "37e4432c", "ce0b6d35", "a46f561c", "7c06a271", "d0569ee5"],
    run: async (driver) => {
      const inside: Array<{ tool: ThreadStatus; hook: ThreadStatus }> = []
      let hookStatus: ThreadStatus | undefined
      const look = defineHook({
        hook: "filter_messages",
        id: "look",
        execute: async (state, messages) => {
          hookStatus = await state.status()
          return messages
        },
      })
      const probe = defineTool({
        description: "Read the run status",
        execute: async (state: ThreadState) => {
          await state.setStatus("a label for the parent registry")
          inside.push({ tool: await state.status(), hook: hookStatus as ThreadStatus })
          return ok("read")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_probe", name: "probe", arguments: {} }] },
        { text: "fine" },
        { reject: new ProviderError("the endpoint is down", "invalid_request") },
        { toolCalls: [{ id: "c_again", name: "probe", arguments: {} }] },
        { text: "back" },
      ])
      await using(
        driver,
        { provider, tools: { probe }, hooks: [look], prompt: { hooks: ["look"] } },
        async (session, thread) => {
          expect(await statusOf(session, thread)).toEqual({ state: "idle", since: 0, reason: null })
          expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response" })
          const running = inside[0]
          expect(running).toEqual({
            tool: { state: "running", since: expect.any(Number), reason: null },
            hook: running?.tool,
          })
          const idle = await statusOf(session, thread)
          expect(idle).toMatchObject({ state: "idle", reason: "stop_on_response" })
          expect(idle.since).toBeGreaterThan(running?.tool.since ?? Number.POSITIVE_INFINITY)
          expect(String(idle.since)).toHaveLength(16)
          expect(await statusOf(session, thread)).toEqual(idle)
          expect(await session.send(thread, "fail")).toMatchObject({ status: "failed", reason: "step_error" })
          const failed = await statusOf(session, thread)
          expect(failed).toMatchObject({ state: "failed", reason: "step_error" })
          expect(failed.since).toBeGreaterThan(idle.since)
          const peer = await session.peer()
          try {
            expect(await statusOf(peer, thread)).toEqual(failed)
          } finally {
            await peer.close()
          }
          expect(await statusOf(session, thread)).toEqual(failed)
          expect(await session.send(thread, "recover")).toMatchObject({ status: "idle", reason: "stop_on_response" })
          expect(inside[1]?.tool).toMatchObject({ state: "running", reason: null })
          expect(inside[1]?.tool.since).toBeGreaterThan(failed.since)
        },
      )
    },
  },
  {
    name: "R16 settles each run with the stop reason code that applies",
    requirements: ["1a0354bc", "7029c151"],
    run: async (driver) => {
      const finish = stubTool("Finish", "finished")
      const loop = stubTool("Loop", "again")
      const provider = new ScriptedProvider([
        { text: "a reply" },
        { toolCalls: [{ id: "c_finish", name: "finish", arguments: {} }] },
        { toolCalls: [{ id: "c_loop1", name: "loop", arguments: {} }] },
        { toolCalls: [{ id: "c_loop2", name: "loop", arguments: {} }] },
        { reject: new ProviderError("refused", "auth_error") },
      ])
      await using(
        driver,
        { provider, tools: { finish, loop }, side: { stopTool: "finish", maxSteps: 2 } },
        async (session, thread) => {
          const reasons: Array<unknown> = []
          for (const text of ["reply", "finish", "loop"]) {
            const outcome = await session.send(thread, text)
            reasons.push([outcome.status, outcome.reason, await statusOf(session, thread)])
          }
          const failed = await session.send(thread, "fail")
          reasons.push([failed.status, failed.reason, await statusOf(session, thread)])
          expect(reasons).toEqual(
            [
              ["idle", "stop_on_response"],
              ["idle", "stop_tool"],
              ["idle", "max_side_steps"],
              ["failed", "step_error"],
            ].map(([state, reason]) => [state, reason, { state, since: expect.any(Number), reason }]),
          )
        },
      )
      const missing = new ScriptedProvider([])
      await using(
        driver,
        {
          provider: missing,
          prompt: { variables: [{ name: "REQUIRED_VALUE", type: "text", required: true, description: "Needed" }] },
        },
        async (session, thread) => {
          expect(await session.send(thread, "go")).toMatchObject({ status: "failed", reason: "fatal_error" })
          expect(await statusOf(session, thread)).toMatchObject({ state: "failed", reason: "fatal_error" })
          expect(missing.requests).toHaveLength(0)
        },
      )
    },
  },
]
