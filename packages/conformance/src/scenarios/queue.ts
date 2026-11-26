import {
  type AttachmentRef,
  defineHook,
  defineTool,
  type ExecutionState,
  type Message,
  type ThreadState,
  type ToolResult,
} from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import type { LoadOptions, RuntimeDriver, RuntimeSession } from "../RuntimeDriver.ts"
import { type RecordedRequest, ScriptedProvider } from "../ScriptedProvider.ts"
import { rolesFor, SIDES } from "./messages.ts"
import { callsOf, gate, history, ok, project, type Scenario, type Setup, sideOf } from "./step-loop.ts"

// A short lease, so that a session notices within a tenth of a second that another session settled its run.
const LEASE: LoadOptions = { holderTimeoutMs: 500 }

const using = async (
  driver: RuntimeDriver,
  setup: Setup,
  body: (session: RuntimeSession, thread: string) => Promise<void>,
  options: LoadOptions = LEASE,
) => {
  const session = await driver.load(project(setup), options)
  try {
    await body(session, await session.createThread("assistant"))
  } finally {
    await session.close()
  }
}

const echo = defineTool({
  description: "Return the text it is given",
  args: z.object({ text: z.string() }),
  execute: async (_state, { text }) => ok(text),
})

const noop = defineTool({ description: "Do nothing", execute: async () => ok("noop") })

// A response whose text names the user messages that the request ends with, so that a request shows what it held.
const acknowledge = (request: RecordedRequest) => {
  const trailing: Array<string> = []
  const messages = history(request)
  for (let index = messages.length - 1; index >= 0 && messages[index]?.role === "user"; index--)
    trailing.unshift(String(messages[index]?.content))
  return { text: `ack: ${trailing.join(" | ")}` }
}

const shape = (messages: ReadonlyArray<Message>) =>
  messages.map((message) => [message.role, message.role === "tool" ? message.tool_call_id : message.content])

const ref: AttachmentRef = {
  id: "file-1",
  type: "file",
  path: "/notes/a.txt",
  name: "a.txt",
  mimeType: "text/plain",
  size: 4,
}

const statusOf = async (session: RuntimeSession, thread: string) => (await session.state(thread)).status()

export const queueScenarios: ReadonlyArray<Scenario> = [
  {
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
      await using(
        driver,
        { provider: settling, hooks: [late], prompt: { hooks: ["late"] } },
        async (session, thread) => {
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
        },
      )
    },
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_slow", name: "slow", arguments: {} }] },
        acknowledge,
      ])
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
  },
  {
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
        const results = (await session.messages(thread)).filter((m) => m.role === "tool").map((m) => m.content)
        expect(results.filter((text) => text?.startsWith("queued by"))).toEqual([
          "queued by omitted",
          "queued by listed",
        ])
      })
    },
  },
  {
    name: "Q11 lets the model call in flight finish when stop is called, then runs no tool and no step and settles idle",
    requirements: ["7a032a6c", "7a728ef6", "da3295e2", "37e4432c"],
    run: async (driver) => {
      for (const humanOn of SIDES) {
        let execution: ExecutionState | null = null
        const ran: Array<string> = []
        const keep = defineHook({
          hook: "filter_messages",
          id: "keep",
          execute: async (state, messages) => {
            execution = state.execution
            return messages
          },
        })
        const held = gate()
        const release = gate()
        const provider = new ScriptedProvider([
          async () => {
            held.release()
            await release.opened
            return { text: "partial", toolCalls: [{ id: "c_noop", name: "noop", arguments: {} }] }
          },
          { text: "next" },
        ])
        const tracked = defineTool({
          description: "Do nothing",
          execute: async () => {
            ran.push("noop")
            return ok("noop")
          },
        })
        await using(
          driver,
          { provider, humanOn, tools: { noop: tracked }, hooks: [keep], prompt: { hooks: ["keep"] } },
          async (session, thread) => {
            const run = session.send(thread, "go")
            await held.opened
            const active = execution as ExecutionState | null
            expect(active?.stopped).toBe(false)
            expect(active?.stop()).toBeUndefined()
            expect([active?.stopped, active?.stoppedBy, active?.abortSignal.aborted]).toEqual([
              true,
              humanOn === "b" ? "a" : "b",
              false,
            ])
            release.release()
            expect(await run).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
            expect(ran).toEqual([])
            expect(provider.requests).toHaveLength(1)
            const stored = await session.messages(thread)
            expect(stored.map((m) => [m.role === "tool" ? "tool" : m.content, m.tool_status])).toEqual([
              ["go", null],
              ["partial", null],
              ["tool", "error"],
            ])
            const state = await session.state(thread)
            expect([await state.status(), state.terminated]).toEqual([
              { state: "idle", since: expect.any(Number), reason: "aborted" },
              null,
            ])
            expect(await session.send(thread, "again")).toMatchObject({ status: "idle", reason: "stop_on_response" })
          },
        )
      }
    },
  },
  {
    name: "Q12 lets a running tool finish after stop, runs no later call, and starts a send that waited only after it settles",
    requirements: ["7a032a6c", "7a728ef6", "6f984718", "0953e887"],
    run: async (driver) => {
      for (const watching of [true, false]) {
        const held = gate()
        const release = gate()
        let finished = false
        let execution: ExecutionState | null = null
        const observed: Array<unknown> = []
        // The tool exposes its execution, so that the test calls stop while the tool runs. A watching tool also ends
        // when the abort signal fires, and stop does not fire it.
        const hold = defineTool({
          description: "Wait for the test",
          execute: async (state: ThreadState) => {
            execution = state.execution
            const signal = state.execution?.abortSignal
            held.release()
            await (watching
              ? Promise.race([release.opened, new Promise((resolve) => signal?.addEventListener("abort", resolve))])
              : release.opened)
            observed.push({ stopped: state.execution?.stopped, aborted: signal?.aborted })
            finished = true
            return ok("held")
          },
        })
        const ran: Array<string> = []
        const second = defineTool({
          description: "Record that it ran",
          execute: async () => {
            ran.push("second")
            return ok("second")
          },
        })
        const provider = new ScriptedProvider([
          {
            toolCalls: [
              { id: "c_hold", name: "hold", arguments: {} },
              { id: "c_second", name: "second", arguments: {} },
            ],
          },
          (request) => ({ text: `after the tool: ${finished}, ${history(request).at(-1)?.content}` }),
        ])
        await using(driver, { provider, tools: { hold, second } }, async (session, thread) => {
          const run = session.send(thread, "go")
          await held.opened
          const waiting = session.send(thread, "next")
          ;(execution as ExecutionState | null)?.stop()
          release.release()
          expect(await run).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
          expect(observed).toEqual([{ stopped: true, aborted: false }])
          expect(ran).toEqual([])
          expect(await waiting).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
          expect(provider.requests).toHaveLength(2)
          expect((await session.messages(thread)).map((m) => [m.role, m.tool_status ?? m.content])).toEqual([
            ["user", "go"],
            ["assistant", null],
            ["tool", "success"],
            ["tool", "error"],
            ["user", "next"],
            ["assistant", "after the tool: true, next"],
          ])
        })
      }
    },
  },
  {
    name: "Q13 aborts a running thread that another session terminates, marks it, and refuses every later admission",
    requirements: ["b4305106", "e95fd065", "dc7d7df0", "d0a36934", "54d362c5", "9090af10", "f0250a42", "7b26e7c9"],
    run: async (driver) => {
      const held = gate()
      let signal: AbortSignal | undefined
      const watch = defineTool({
        description: "Wait for the abort",
        execute: async (state: ThreadState) => {
          signal = state.execution?.abortSignal
          held.release()
          await new Promise((resolve) => signal?.addEventListener("abort", resolve))
          return ok("aborted")
        },
      })
      const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_watch", name: "watch", arguments: {} }] }])
      await using(driver, { provider, tools: { watch, echo } }, async (session, thread) => {
        const run = session.send(thread, "go")
        await held.opened
        const peer = await session.peer()
        try {
          const before = await peer.state(thread)
          await before.queueMessage({ role: "user", content: "pending" })
          expect(await before.terminate()).toBeUndefined()
          expect(await run).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
          expect(signal?.aborted).toBe(true)
          const after = await peer.state(thread)
          expect(after.terminated).toEqual(expect.any(Number))
          expect(String(after.terminated)).toHaveLength(16)
          expect(await after.status()).toMatchObject({ state: "idle", reason: "aborted" })
          expect((await session.messages(thread)).map((m) => [m.role, m.tool_status ?? m.content])).toEqual([
            ["user", "go"],
            ["assistant", null],
            ["tool", "error"],
          ])
          const refusal = `thread ${thread} is terminated, so it takes no new message, queued work, or execution`
          for (const state of [before, after, await session.state(thread)]) {
            await expect(state.queueMessage({ role: "user", content: "late" })).rejects.toThrow(refusal)
            expect(() => state.queueTool("echo", { text: "late" })).toThrow(refusal)
          }
          await expect(peer.send(thread, "late")).rejects.toThrow(refusal)
          await expect(session.send(thread, "late")).rejects.toThrow(refusal)
          expect(provider.requests).toHaveLength(1)
          expect(await session.messages(thread)).toHaveLength(3)
        } finally {
          await peer.close()
        }
      })
    },
  },
  {
    name: "Q14 terminates a thread at rest without a run, keeps its history readable, and refuses every later admission",
    requirements: ["b4305106", "dc7d7df0", "d0a36934", "9090af10", "f0250a42", "7b26e7c9", "b83b63ca"],
    run: async (driver) => {
      const provider = new ScriptedProvider([{ text: "first reply" }])
      await using(driver, { provider, tools: { echo } }, async (session, thread) => {
        const fresh = await session.createThread("assistant")
        expect(await session.send(thread, "first")).toMatchObject({ status: "idle" })
        const handles = [await session.state(thread), await session.state(fresh)]
        const settled = await handles[0]?.status()
        for (const handle of handles) expect(await handle.terminate()).toBeUndefined()
        const peer = await session.peer()
        try {
          const reopened = await peer.state(thread)
          const marker = reopened.terminated
          expect(marker).toEqual(expect.any(Number))
          await reopened.terminate()
          expect((await peer.state(thread)).terminated).toBe(marker)
          expect(await reopened.status()).toEqual(settled)
          expect(await (await peer.state(fresh)).status()).toEqual({ state: "idle", since: 0, reason: null })
          expect((await reopened.getMessages({ order: "asc" })).messages.map((m) => m.content)).toEqual([
            "first",
            "first reply",
          ])
          for (const [id, state] of [
            [thread, reopened],
            [fresh, await peer.state(fresh)],
            [thread, handles[0]],
          ] as const) {
            const refusal = `thread ${id} is terminated, so it takes no new message, queued work, or execution`
            await expect(state?.queueMessage({ role: "user", content: "late" })).rejects.toThrow(refusal)
            expect(() => state?.queueTool("echo", { text: "late" })).toThrow(refusal)
            await expect(peer.send(id, "late")).rejects.toThrow(refusal)
          }
          expect(provider.requests).toHaveLength(1)
        } finally {
          await peer.close()
        }
      })
    },
  },
  {
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
  },
  {
    name: "Q16 ends a write that a tool's injectMessage started when terminate aborts the run, and refuses the tool's later calls",
    requirements: ["e95fd065"],
    run: async (driver) => {
      const inHook = gate()
      const releaseHook = gate()
      const toolStarted = gate()
      let toolState: ThreadState | undefined
      let injection: Promise<unknown> | undefined
      const slow = defineHook({
        hook: "before_create_message",
        id: "slow",
        execute: async (_state, message) => {
          if (message.content === "from the tool") {
            inHook.release()
            await releaseHook.opened
          }
          return message
        },
      })
      const inject = defineTool({
        description: "Inject a message and wait",
        execute: async (state: ThreadState) => {
          toolState = state
          injection = state.injectMessage({ role: "user", content: "from the tool" }).then(
            () => "stored",
            (error: Error) => `rejected: ${error.message}`,
          )
          toolStarted.release()
          await new Promise(() => {})
          return ok("never")
        },
      })
      const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_inject", name: "inject", arguments: {} }] }])
      await using(
        driver,
        { provider, tools: { inject }, hooks: [slow], prompt: { hooks: ["slow"] } },
        async (session, thread) => {
          const run = session.send(thread, "go")
          await Promise.all([toolStarted.opened, inHook.opened])
          await (await session.state(thread)).terminate()
          expect(await run).toMatchObject({ status: "idle", reason: "aborted" })
          releaseHook.release()
          expect(await injection).toMatch(/^rejected: /)
          await expect(toolState?.getValue("anything")).rejects.toThrow(/has ended, so Spindle refused this call/)
          expect((await session.messages(thread)).map((m) => m.content)).not.toContain("from the tool")
        },
      )
    },
  },
  {
    name: "Q17 stores a queued call and a queued message that a tool wrote without its secrets, and runs the tool with them",
    requirements: [],
    run: async (driver) => {
      const token = "QUEUED-SECRET-81"
      const received: Array<string> = []
      const take = defineTool({
        description: "Return what it was given",
        args: z.object({ text: z.string() }),
        execute: async (_state, { text }) => {
          received.push(text)
          return ok(`took ${text}`)
        },
      })
      const queue = defineTool({
        description: "Queue a tool and a message that hold a secret",
        variables: [{ name: "QUEUE_TOKEN", type: "secret", required: true, description: "A secret" }],
        execute: async (state: ThreadState) => {
          const secret = await state.env("QUEUE_TOKEN")
          state.queueTool("take", { text: secret })
          await state.queueMessage({ role: "user", content: `note ${secret}`, metadata: { [secret]: secret } })
          return ok("queued")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_queue", name: "queue", arguments: {} }] },
        { text: "done" },
      ])
      const session = await driver.load(project({ provider, tools: { queue, take } }), {
        ...LEASE,
        instanceEnv: { QUEUE_TOKEN: token },
      })
      try {
        const thread = await session.createThread("assistant")
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        expect(received).toEqual([token])
        const stored = await session.messages(thread)
        expect(JSON.stringify(stored)).not.toContain(token)
        expect(JSON.stringify(provider.requests)).not.toContain(token)
        expect(
          stored.map((m) => [m.role, m.tool_calls === null ? m.content : callsOf(m)[0]?.function.arguments]),
        ).toEqual([
          ["user", "go"],
          ["assistant", "{}"],
          ["tool", "queued"],
          ["assistant", '{"text":"[redacted]"}'],
          ["tool", "took [redacted]"],
          ["user", "note [redacted]"],
          ["assistant", "done"],
        ])
        expect(stored[5]?.metadata).toEqual({ "[redacted]": "[redacted]" })
      } finally {
        await session.close()
      }
    },
  },
]
