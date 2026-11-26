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
import { attempt } from "./ownership.ts"
import { callsOf, gate, history, holding, ok, project, type Scenario, type Setup, sideOf } from "./step-loop.ts"

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

// A send that a failed expectation leaves behind is rejected when its session closes. Nothing awaits it then.
const quiet = <A>(promise: Promise<A>): Promise<A> => {
  promise.catch(() => undefined)
  return promise
}

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
  {
    name: "Q18 does not run a queued tool whose started hook or create hook calls stop, and stores one result that says so",
    requirements: ["7a032a6c"],
    run: async (driver) => {
      const started = defineHook({
        hook: "tool_call_started",
        id: "stop_when_started",
        execute: async (state) => {
          state.execution?.stop()
        },
      })
      const beforeCreate = defineHook({
        hook: "before_create_message",
        id: "stop_before_create",
        execute: async (state, message) => {
          if (message.metadata?.queued === true) state.execution?.stop()
          return message
        },
      })
      const afterCreate = defineHook({
        hook: "after_create_message",
        id: "stop_after_create",
        execute: async (state, message) => {
          if (message.metadata?.queued === true) state.execution?.stop()
        },
      })
      const seen: Record<string, unknown> = {}
      for (const hook of [started, beforeCreate, afterCreate]) {
        let entries = 0
        const worker = defineTool({
          description: "Count each run",
          execute: async () => {
            entries += 1
            return ok("the effect happened")
          },
        })
        const provider = new ScriptedProvider([{ text: "a reply that no stopped run asks for" }])
        await using(
          driver,
          { provider, tools: { worker }, hooks: [hook], prompt: { hooks: [hook.id] } },
          async (session, thread) => {
            ;(await session.state(thread)).queueTool("worker", {})
            const outcome = await session.settled(thread)
            const stored = await session.messages(thread)
            const call = callsOf(stored.find((message) => message.metadata?.queued === true))[0]
            const results = stored.filter((message) => message.role === "tool")
            seen[hook.id] = {
              entries,
              outcome: [outcome?.status, outcome?.reason],
              requests: provider.requests.length,
              results: results.map((m) => [
                m.tool_call_id === call?.id,
                m.tool_status,
                /did not run/.test(m.content ?? ""),
              ]),
            }
          },
        )
      }
      const stopped = { entries: 0, outcome: ["idle", "aborted"], requests: 0, results: [[true, "error", true]] }
      expect(seen).toEqual({ stop_when_started: stopped, stop_before_create: stopped, stop_after_create: stopped })
    },
  },
  {
    name: "Q19 does not retry a model attempt that was cut off after stop was called",
    requirements: ["7a032a6c"],
    run: async (driver) => {
      let execution: ExecutionState | null = null
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
          // A stream that ends with no finish chunk is an attempt the provider cut off, which a run retries.
          return { chunks: [] }
        },
        { text: "from the retry" },
      ])
      await using(driver, { provider, hooks: [keep], prompt: { hooks: ["keep"] } }, async (session, thread) => {
        const run = quiet(session.send(thread, "go"))
        await held.opened
        ;(execution as ExecutionState | null)?.stop()
        release.release()
        const outcome = await run
        expect({
          requests: provider.requests.length,
          outcome: [outcome.status, outcome.reason],
          stored: (await session.messages(thread)).map((message) => message.content),
        }).toEqual({ requests: 1, outcome: ["idle", "aborted"], stored: ["go"] })
      })
    },
  },
  {
    name: "Q20 runs a queued tool once when its started hook and its create hooks ask for no stop",
    requirements: [],
    run: async (driver) => {
      let entries = 0
      const calls: Array<string> = []
      const worker = defineTool({
        description: "Count each run",
        execute: async () => {
          entries += 1
          return ok("the effect happened")
        },
      })
      const started = defineHook({
        hook: "tool_call_started",
        id: "watch_started",
        execute: async (_state, call) => {
          calls.push(call.function.name)
        },
      })
      const provider = new ScriptedProvider([{ text: "saw it" }])
      await using(
        driver,
        { provider, tools: { worker }, hooks: [started], prompt: { hooks: ["watch_started"] } },
        async (session, thread) => {
          ;(await session.state(thread)).queueTool("worker", {})
          expect(await session.settled(thread)).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
          expect([entries, calls]).toEqual([1, ["worker"]])
          expect((await session.messages(thread)).map((m) => m.tool_status ?? m.content)).toEqual([
            null,
            "success",
            "saw it",
          ])
        },
      )
    },
  },
  {
    name: "Q21 keeps the result of a call that a stop left unstarted an error that says it did not run, whatever a hook returns",
    requirements: ["7a032a6c"],
    run: async (driver) => {
      const success = { status: "success" as const, result: "sent successfully" }
      const failureHook = defineHook({
        hook: "after_tool_call_failure",
        id: "relabel_failure",
        execute: async () => success,
      })
      const resultHook = defineHook({
        hook: "before_store_tool_result",
        id: "relabel_result",
        execute: async () => success,
      })
      const createHook = defineHook({
        hook: "before_create_message",
        id: "relabel_message",
        execute: async (_state, message) =>
          message.role === "tool"
            ? { ...message, tool_status: "success" as const, content: "sent successfully" }
            : message,
      })
      const seen: Record<string, unknown> = {}
      for (const hook of [failureHook, resultHook, createHook]) {
        let execution: ExecutionState | null = null
        let entries = 0
        const keep = defineHook({
          hook: "filter_messages",
          id: "keep",
          execute: async (state, messages) => {
            execution = state.execution
            return messages
          },
        })
        const worker = defineTool({
          description: "Count each run",
          execute: async () => {
            entries += 1
            return ok("the effect happened")
          },
        })
        const held = gate()
        const release = gate()
        const provider = new ScriptedProvider([
          async () => {
            held.release()
            await release.opened
            return {
              toolCalls: [
                { id: "x", name: "worker", arguments: {} },
                { id: "y", name: "worker", arguments: {} },
              ],
            }
          },
        ])
        await using(
          driver,
          { provider, tools: { worker }, hooks: [keep, hook], prompt: { hooks: ["keep", hook.id] } },
          async (session, thread) => {
            const run = quiet(session.send(thread, "go"))
            await held.opened
            ;(execution as ExecutionState | null)?.stop()
            release.release()
            const outcome = await run
            const results = (await session.messages(thread)).filter((message) => message.role === "tool")
            seen[hook.id] = {
              entries,
              outcome: [outcome.status, outcome.reason],
              results: results.map((m) => [m.tool_call_id, m.tool_status, /did not run/.test(m.content ?? "")]),
            }
          },
        )
      }
      const kept = {
        entries: 0,
        outcome: ["idle", "aborted"],
        results: [
          ["x", "error", true],
          ["y", "error", true],
        ],
      }
      expect(seen).toEqual({ relabel_failure: kept, relabel_result: kept, relabel_message: kept })
    },
  },
  {
    name: "Q22 still lets a failure hook replace the result of a call that ran and failed",
    requirements: [],
    run: async (driver) => {
      let entries = 0
      const failing = defineTool({
        description: "Run and fail",
        execute: async () => {
          entries += 1
          return { status: "error" as const, error: "the tool failed" }
        },
      })
      const recover = defineHook({
        hook: "after_tool_call_failure",
        id: "recover",
        execute: async () => ({ status: "success" as const, result: "recovered by the hook" }),
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_failing", name: "failing", arguments: {} }] },
        { text: "done" },
      ])
      await using(
        driver,
        { provider, tools: { failing }, hooks: [recover], prompt: { hooks: ["recover"] } },
        async (session, thread) => {
          expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
          const result = (await session.messages(thread)).find((message) => message.role === "tool")
          expect([entries, result?.tool_call_id, result?.tool_status, result?.content]).toEqual([
            1,
            "c_failing",
            "success",
            "recovered by the hook",
          ])
        },
      )
    },
  },
  {
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
        { provider, hooks: [again], prompt: { hooks: ["again"] } },
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
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
  },
  {
    name: "Q28 throws from queueTool when the arguments hold a known secret at any depth or in a property name, and queues nothing",
    requirements: [],
    run: async (driver) => {
      const token = "QUEUED-SECRET-28"
      const tried = gate()
      const leave = gate()
      const received: Array<unknown> = []
      const refusals: Array<{ tag: string; message: string }> = []
      const take = defineTool({
        description: "Record what it was given",
        execute: async () => {
          received.push("ran")
          return ok("took")
        },
      })
      const queue = defineTool({
        description: "Try to queue a tool with a secret in its arguments",
        variables: [{ name: "QUEUE_TOKEN", type: "secret", required: true, description: "A secret" }],
        execute: async (state: ThreadState) => {
          const secret = await state.env("QUEUE_TOKEN")
          for (const args of [
            { text: secret },
            { nested: { list: [{ deep: `before ${secret} after` }] } },
            { [secret]: 1 },
            { nested: [{ [`key ${secret}`]: true }] },
          ])
            try {
              state.queueTool("take", args)
              refusals.push({ tag: "accepted", message: "" })
            } catch (error) {
              const refused = error as { _tag?: string; message?: string }
              refusals.push({ tag: String(refused._tag), message: String(refused.message) })
            }
          tried.release()
          await leave.opened
          return ok("tried")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_queue", name: "queue", arguments: {} }] },
        { text: "done" },
      ])
      const session = await driver.load(project({ provider, tools: { queue, take } }), {
        instanceEnv: { QUEUE_TOKEN: token },
      })
      try {
        const thread = await session.createThread("assistant")
        const run = quiet(session.send(thread, "go"))
        await tried.opened
        const whileHeld = (await session.inspect(thread)).queue
        leave.release()
        expect(await run).toMatchObject({ status: "idle", steps: 2 })
        expect({
          tags: refusals.map((refusal) => refusal.tag),
          queued: whileHeld.map((entry) => entry.kind),
          received,
        }).toEqual({ tags: Array.from({ length: 4 }, () => "SecretInArguments"), queued: [], received: [] })
        expect(holding(refusals, token)).toEqual([])
      } finally {
        await session.close()
      }
    },
  },
  {
    name: "Q29 redacts the name and the description of a queued attachment before the queue stores the entry",
    requirements: [],
    run: async (driver) => {
      const token = "QUEUED-SECRET-29"
      const queuedIt = gate()
      const leave = gate()
      const queue = defineTool({
        description: "Queue a message whose attachment names a secret",
        variables: [{ name: "QUEUE_TOKEN", type: "secret", required: true, description: "A secret" }],
        execute: async (state: ThreadState) => {
          const secret = await state.env("QUEUE_TOKEN")
          await state.queueMessage({
            role: "user",
            content: "see the file",
            attachments: [{ ...ref, name: `${secret}.txt`, description: `about ${secret}` }],
          })
          queuedIt.release()
          await leave.opened
          return ok("queued")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_queue", name: "queue", arguments: {} }] },
        { text: "done" },
      ])
      const session = await driver.load(project({ provider, tools: { queue } }), {
        instanceEnv: { QUEUE_TOKEN: token },
      })
      try {
        const thread = await session.createThread("assistant")
        const run = quiet(session.send(thread, "go"))
        await queuedIt.opened
        const whileHeld = (await session.inspect(thread)).queue
        leave.release()
        expect(await run).toMatchObject({ status: "idle", steps: 2 })
        expect(whileHeld).toHaveLength(1)
        expect(
          holding(
            whileHeld.map((entry) => JSON.parse(entry.payload) as unknown),
            token,
          ),
        ).toEqual([])
        const stored = await session.messages(thread)
        expect(stored.find((message) => message.content === "see the file")?.attachments).toEqual([
          { ...ref, name: "[redacted].txt", description: "about [redacted]" },
        ])
        expect(holding(stored, token)).toEqual([])
        expect(holding(provider.requests, token)).toEqual([])
      } finally {
        await session.close()
      }
    },
  },
  {
    name: "Q30 keeps the id and the tool name of a queued call that a secret overlaps, and pairs its result with it",
    requirements: ["41278e5e"],
    run: async (driver) => {
      const ran: Array<string> = []
      const worker = defineTool({
        description: "Record the run",
        execute: async () => {
          ran.push("worker")
          return ok("ran")
        },
      })
      const queue = defineTool({
        description: "Learn three secrets, then queue a tool",
        execute: async (state: ThreadState) => {
          for (const name of ["ID_PREFIX", "TOOL_NAME", "FIELD_NAME"]) await state.instanceEnv?.(name)
          state.queueTool("worker", {})
          return ok("queued")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_queue", name: "queue", arguments: {} }] },
        { text: "done" },
      ])
      // The values equal the prefix of a queued call's id, the name of the queued tool, and a field name of a stored call.
      const session = await driver.load(project({ provider, tools: { queue, worker } }), {
        instanceEnv: { ID_PREFIX: "queued-", TOOL_NAME: "worker", FIELD_NAME: "arguments" },
      })
      try {
        const thread = await session.createThread("assistant")
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const stored = await session.messages(thread)
        const [call] = callsOf(stored.find((message) => message.metadata?.queued === true))
        const results = stored.filter((message) => message.role === "tool" && message.tool_call_id !== "c_queue")
        expect({
          call: { ...call, id: call?.id.includes("[redacted]") === false },
          results: results.map((m) => [m.tool_call_id === call?.id, m.name, m.tool_status]),
          ran,
        }).toEqual({
          call: { id: true, type: "function", function: { name: "worker", arguments: "{}" } },
          results: [[true, "worker", "success"]],
          ran: ["worker"],
        })
        expect(history(provider.requests[1]).map(sideOf).slice(-2)).toEqual([
          ["assistant", null, [call?.id]],
          ["tool", call?.id],
        ])
      } finally {
        await session.close()
      }
    },
  },
  {
    name: "Q31 leaves no secret that holds a quote in the decoded arguments of a stored queued call or in the next request",
    requirements: [],
    run: async (driver) => {
      const token = 'canary"quoted'
      const received: Array<string> = []
      const take = defineTool({
        description: "Record what it was given",
        args: z.object({ text: z.string() }),
        execute: async (_state, { text }) => {
          received.push(text)
          return ok("took it")
        },
      })
      // The tool queues the value before the runtime knows it as a secret, so the call is admitted. The runtime
      // learns the value afterwards, and the stored call must not show it.
      const queue = defineTool({
        description: "Queue a value, then learn that it is a secret",
        execute: async (state: ThreadState) => {
          state.queueTool("take", { text: token })
          await state.instanceEnv?.("LATE_TOKEN")
          return ok("queued")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_queue", name: "queue", arguments: {} }] },
        { text: "done" },
      ])
      const session = await driver.load(project({ provider, tools: { queue, take } }), {
        instanceEnv: { LATE_TOKEN: token },
      })
      try {
        const thread = await session.createThread("assistant")
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        const stored = await session.messages(thread)
        const [call] = callsOf(stored.find((message) => message.metadata?.queued === true))
        const decoded = JSON.parse(call?.function.arguments ?? "null") as unknown
        expect(received).toHaveLength(1)
        expect({ inArguments: holding(decoded, token), inRequests: holding(provider.requests, token) }).toEqual({
          inArguments: [],
          inRequests: [],
        })
        expect(holding(stored, token)).toEqual([])
      } finally {
        await session.close()
      }
    },
  },
  {
    name: "Q32 queues a tool whose arguments hold no secret from a tool that knows one, and runs it with those arguments",
    requirements: [],
    run: async (driver) => {
      const received: Array<string> = []
      const take = defineTool({
        description: "Record what it was given",
        args: z.object({ text: z.string() }),
        execute: async (_state, { text }) => {
          received.push(text)
          return ok(`took ${text}`)
        },
      })
      const queue = defineTool({
        description: "Read a secret, then queue plain arguments",
        variables: [{ name: "QUEUE_TOKEN", type: "secret", required: true, description: "A secret" }],
        execute: async (state: ThreadState) => {
          await state.env("QUEUE_TOKEN")
          state.queueTool("take", { text: "plain text" })
          return ok("queued")
        },
      })
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c_queue", name: "queue", arguments: {} }] },
        { text: "done" },
      ])
      const session = await driver.load(project({ provider, tools: { queue, take } }), {
        instanceEnv: { QUEUE_TOKEN: "QUEUED-SECRET-32" },
      })
      try {
        const thread = await session.createThread("assistant")
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        expect(received).toEqual(["plain text"])
        expect((await session.messages(thread)).map((m) => m.content)).toContain("took plain text")
      } finally {
        await session.close()
      }
    },
  },
  {
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
  },
  {
    name: "Q34 fails a send that waited behind a run with ThreadTerminated when another session terminates the thread",
    requirements: ["dc7d7df0", "9090af10"],
    run: async (driver) => {
      const held = gate()
      const watch = defineTool({
        description: "Wait for the abort",
        execute: async (state: ThreadState) => {
          const signal = state.execution?.abortSignal
          held.release()
          await new Promise((resolve) => signal?.addEventListener("abort", resolve))
          return ok("aborted")
        },
      })
      const provider = new ScriptedProvider([{ toolCalls: [{ id: "c_watch", name: "watch", arguments: {} }] }])
      await using(driver, { provider, tools: { watch } }, async (session, thread) => {
        const waiter = await session.peer()
        const other = await session.peer()
        try {
          const run = quiet(session.send(thread, "go"))
          await held.opened
          const behindHere = attempt(() => session.send(thread, "waited here"))
          const behindElsewhere = attempt(() => waiter.send(thread, "waited elsewhere"))
          // Both sends are durable once their entries are in the queue. The poll only waits for those two writes.
          for (let tries = 0; tries < 500 && (await other.inspect(thread)).queue.length < 2; tries++)
            await new Promise((resolve) => setTimeout(resolve, 10))
          await (await other.state(thread)).terminate()
          expect(await run).toMatchObject({ status: "idle", reason: "aborted" })
          expect({ behindHere: await behindHere, behindElsewhere: await behindElsewhere }).toEqual({
            behindHere: "ThreadTerminated",
            behindElsewhere: "ThreadTerminated",
          })
          expect(shape(await session.messages(thread)).map((row) => row[0])).toEqual(["user", "assistant", "tool"])
          expect(provider.requests).toHaveLength(1)
        } finally {
          await waiter.close()
          await other.close()
        }
      })
    },
  },
  {
    name: "Q35 never reports idle to a sender whose run could not be settled",
    requirements: ["37e4432c"],
    run: async (driver) => {
      const provider = new ScriptedProvider([{ text: "a reply" }])
      await using(driver, { provider }, async (session, thread) => {
        await session.breakSettlement(thread)
        const reported = await session.send(thread, "go").then(
          (outcome) => outcome.status,
          () => "rejected",
        )
        const stored = await session.inspect(thread)
        expect([stored.status.state, reported === "idle" ? "idle" : "a failure"]).toEqual(["running", "a failure"])
      })
    },
  },
  {
    name: "Q36 shows the termination time on the handle whose terminate() resolved",
    requirements: ["7b26e7c9"],
    run: async (driver) => {
      const provider = new ScriptedProvider([])
      await using(driver, { provider }, async (session, thread) => {
        const state = await session.state(thread)
        expect(state.terminated).toBeNull()
        await state.terminate()
        const fresh = (await session.state(thread)).terminated
        expect(fresh).toEqual(expect.any(Number))
        expect(state.terminated).toBe(fresh)
      })
    },
  },
  {
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
  },
  {
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
      await using(driver, { provider, tools: { caller, target } }, async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        expect(ran).toEqual(["target"])
      })
    },
  },
  {
    name: "Q39 does not claim an unknown outcome in the result of a call that a lost execution never started",
    requirements: ["286367b3"],
    run: async (driver) => {
      const entered = gate()
      const leave = gate()
      const ran: Array<string> = []
      const hold = defineTool({
        description: "Wait for the test",
        execute: async () => {
          ran.push("hold")
          entered.release()
          await leave.opened
          return ok("returned")
        },
      })
      const later = defineTool({
        description: "Record the run",
        execute: async () => {
          ran.push("later")
          return ok("ran")
        },
      })
      const provider = new ScriptedProvider([
        {
          toolCalls: [
            { id: "c_hold", name: "hold", arguments: {} },
            { id: "c_later", name: "later", arguments: {} },
          ],
        },
      ])
      await using(
        driver,
        { provider, tools: { hold, later } },
        async (session, thread) => {
          const peer = await session.peer()
          try {
            const run = quiet(session.send(thread, "go")).catch(() => undefined)
            await entered.opened
            try {
              await peer.forceRecover(thread)
            } finally {
              leave.release()
            }
            await run
            const results = (await peer.messages(thread)).filter((message) => message.role === "tool")
            const unknown = /does not know whether/
            expect(results.map((m) => [m.tool_call_id, m.tool_status, unknown.test(m.content ?? "")])).toEqual([
              ["c_hold", "error", true],
              ["c_later", "error", false],
            ])
            expect(ran).toEqual(["hold"])
          } finally {
            await peer.close()
          }
        },
        { holderTimeoutMs: 60_000 },
      )
    },
  },
  {
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
          for (let tries = 0; tries < 500 && (await session.inspect(thread)).queue.length < 2; tries++)
            await new Promise((resolve) => setTimeout(resolve, 10))
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
  },
]
