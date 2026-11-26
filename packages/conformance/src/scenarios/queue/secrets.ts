import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { callsOf, gate, history, holding, ok, quiet, type Scenario, sideOf, stubTool, using } from "../harness.ts"

import { ref } from "./fixtures.ts"

export const Q17: Scenario = {
  name: "Q17 refuses the secret in queued tool arguments and stores a redacted queued message",
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
        expect(() => state.queueTool("take", { text: secret })).toThrow()
        await state.queueMessage({ role: "user", content: `note ${secret}`, metadata: { [secret]: secret } })
        return ok("queued")
      },
    })
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c_queue", name: "queue", arguments: {} }] },
      { text: "done" },
    ])

    await using(
      driver,
      { provider, tools: { queue, take } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        expect(received).toEqual([])
        const stored = await session.messages(thread)
        expect(JSON.stringify(stored)).not.toContain(token)
        expect(JSON.stringify(provider.requests)).not.toContain(token)
        expect(
          stored.map((m) => [m.role, m.tool_calls === null ? m.content : callsOf(m)[0]?.function.arguments]),
        ).toEqual([
          ["user", "go"],
          ["assistant", "{}"],
          ["tool", "queued"],
          ["user", "note [redacted]"],
          ["assistant", "done"],
        ])
        expect(stored[3]?.metadata).toEqual({ "[redacted]": "[redacted]" })
      },
      {
        instanceEnv: { QUEUE_TOKEN: token },
      },
    )
  },
}

export const Q41: Scenario = {
  name: "Q41 refuses a queued argument learned from the instance by an at-rest hook",
  requirements: [],
  run: async (driver) => {
    let refusal: unknown
    const hook = defineHook({
      hook: "after_thread_created",
      id: "admit",
      execute: async (state) => {
        const secret = await state.env("UNDECLARED")
        try {
          state.queueTool("take", { secret })
        } catch (error) {
          refusal = error
        }
      },
    })
    const take = stubTool("Return success", "ran")

    await using(
      driver,
      { provider: new ScriptedProvider([]), hooks: [hook], agent: { hooks: ["admit"] }, tools: { take } },
      async (session, thread) => {
        expect(refusal).toMatchObject({ _tag: "SecretInArguments" })
        expect((await session.inspect(thread)).queue).toEqual([])
        expect(await session.messages(thread)).toEqual([])
      },
      { instanceEnv: { UNDECLARED: "example-instance-value" } },
    )
  },
}

export const Q28: Scenario = {
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

    await using(
      driver,
      { provider, tools: { queue, take } },
      async (session, thread) => {
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
      },
      {
        instanceEnv: { QUEUE_TOKEN: token },
      },
    )
  },
}

export const Q29: Scenario = {
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

    await using(
      driver,
      { provider, tools: { queue } },
      async (session, thread) => {
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
      },
      {
        instanceEnv: { QUEUE_TOKEN: token },
      },
    )
  },
}

export const Q30: Scenario = {
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

    await using(
      driver,
      { provider, tools: { queue, worker } },
      async (session, thread) => {
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
      },
      {
        instanceEnv: { ID_PREFIX: "queued-", TOOL_NAME: "worker", FIELD_NAME: "arguments" },
      },
    )
  },
}

export const Q31: Scenario = {
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

    await using(
      driver,
      { provider, tools: { queue, take } },
      async (session, thread) => {
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
      },
      {
        instanceEnv: { LATE_TOKEN: token },
      },
    )
  },
}

export const Q32: Scenario = {
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

    await using(
      driver,
      { provider, tools: { queue, take } },
      async (session, thread) => {
        expect(await session.send(thread, "go")).toMatchObject({ status: "idle", steps: 2 })
        expect(received).toEqual(["plain text"])
        expect((await session.messages(thread)).map((m) => m.content)).toContain("took plain text")
      },
      {
        instanceEnv: { QUEUE_TOKEN: "QUEUED-SECRET-32" },
      },
    )
  },
}
