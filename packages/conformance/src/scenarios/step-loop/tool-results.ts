import { defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { callsOf, counter, history, ok, type Scenario, sideOf, stubTool, toolResults, using } from "../harness.ts"

export const S12: Scenario = {
  name: "S12 validates arguments against the tool schema and runs execute only with the parsed values",
  requirements: ["f3a1cf30", "e2a1037e", "5522b4f9", "2cf0753e"],
  run: async (driver) => {
    const received: Array<unknown> = []
    const tools = {
      book: defineTool({
        description: "Book a room",
        args: z
          .object({
            room: z.object({ floor: z.number().int().min(1), name: z.string() }),
            nights: z.number().default(1),
            note: z.string().optional(),
            vip: z.boolean(),
          })
          .refine((args) => args.nights <= 14, { message: "A stay is at most 14 nights" }),
        execute: async (state, args) => {
          received.push(args)
          await state.setValue("bookings", Number((await state.getValue("bookings")) ?? 0) + 1)
          return ok(JSON.stringify(args))
        },
      }),
      ping: stubTool("Ping", "pong"),
      bookings: defineTool({
        description: "Count bookings",
        execute: async (state: ThreadState) => ok(String((await state.getValue("bookings")) ?? 0)),
      }),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "valid", name: "book", arguments: { room: { floor: 2, name: "Blue" }, vip: true } },
          { id: "wrong_type", name: "book", arguments: { room: { floor: "two", name: "Blue" }, vip: true } },
          { id: "missing", name: "book", arguments: { room: { floor: 1, name: "Red" } } },
          { id: "too_long", name: "book", arguments: { room: { floor: 1, name: "Red" }, vip: false, nights: 30 } },
          { id: "falsy", name: "book", arguments: { room: { floor: 1, name: "" }, vip: false, nights: 0, note: "" } },
          { id: "ping", name: "ping", arguments: {} },
          { id: "count", name: "bookings", arguments: {} },
        ],
      },
      { text: "done" },
    ])
    await using(driver, { provider, tools }, async (session, thread) => {
      expect(await session.send(thread, "book")).toMatchObject({ status: "idle", reason: "stop_on_response" })
      const results = toolResults(await session.messages(thread))
      expect(results.map((m) => [m.tool_call_id, m.tool_status])).toEqual([
        ["valid", "success"],
        ["wrong_type", "error"],
        ["missing", "error"],
        ["too_long", "error"],
        ["falsy", "success"],
        ["ping", "success"],
        ["count", "success"],
      ])
      expect(results[1]?.content).toContain("room.floor")
      expect(results[2]?.content).toContain("vip")
      expect(results[3]?.content).toContain("A stay is at most 14 nights")
      expect(results[6]?.content).toBe("2")
    })
    expect(received).toEqual([
      { room: { floor: 2, name: "Blue" }, nights: 1, vip: true },
      { room: { floor: 1, name: "" }, nights: 0, note: "", vip: false },
    ])
  },
}

export const S13: Scenario = {
  name: "S13 never runs a call whose streamed arguments are not a JSON object and still runs its sibling",
  requirements: ["732b2d4b", "6a7975b1"],
  run: async (driver) => {
    const seen: Array<string> = []
    const tools = {
      lookup: defineTool({
        description: "Look up",
        args: z.object({ q: z.string() }),
        execute: async (_state, { q }) => {
          seen.push(q)
          return ok(`found ${q}`)
        },
      }),
    }
    const usage = { promptTokens: 1, completionTokens: 1, totalTokens: 2 }
    const provider = new ScriptedProvider([
      {
        chunks: [
          { type: "tool-call-start", id: "broken", name: "lookup" },
          { type: "tool-call-delta", id: "broken", argumentsDelta: '{"q": "unterminated' },
          { type: "tool-call-start", id: "fine", name: "lookup" },
          { type: "tool-call-delta", id: "fine", argumentsDelta: '{"q":"ok"}' },
          { type: "tool-call-done", id: "fine", arguments: { q: "ok" } },
          { type: "finish", finishReason: "tool_calls", usage },
        ],
      },
      { text: "done" },
    ])
    await using(driver, { provider, tools }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response" })
      const stored = await session.messages(thread)
      expect(callsOf(stored[1]).map((call) => [call.id, JSON.parse(call.function.arguments)])).toEqual([
        ["broken", { invalid_json: '{"q": "unterminated' }],
        ["fine", { q: "ok" }],
      ])
      const results = toolResults(stored)
      expect(results.map((m) => [m.tool_call_id, m.name, m.tool_status])).toEqual([
        ["broken", "lookup", "error"],
        ["fine", "lookup", "success"],
      ])
      expect(results[0]?.content).toContain("not a valid JSON object")
    })
    expect(seen).toEqual(["ok"])
    const replayed = history(provider.requests[1]).find((message) => message.role === "assistant")
    expect(replayed?.role === "assistant" ? replayed.toolCalls?.map((call) => call.arguments) : []).toEqual([
      { invalid_json: '{"q": "unterminated' },
      { q: "ok" },
    ])
  },
}

export const S14: Scenario = {
  name: "S14 stores every tool outcome as a named, linked result and keeps the loop running",
  requirements: ["732b2d4b", "5522b4f9", "2cf0753e", "2d964c36", "968989f2", "41278e5e", "3b0dd02b"],
  run: async (driver) => {
    const tools = {
      soft: defineTool({
        description: "Fails softly",
        execute: async () => ({ status: "error", error: "soft fail" }),
      }),
      boom: defineTool({
        description: "Throws",
        execute: async () => {
          throw new Error("kaboom")
        },
      }),
      reject: defineTool({ description: "Rejects", execute: () => Promise.reject(new Error("rejected")) }),
      weird: defineTool({
        description: "Throws a value",
        execute: async () => {
          throw { reason: 42 }
        },
      }),
      fine: stubTool("Works", "fine"),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: ["soft", "boom", "reject", "weird", "fine"].map((name) => ({
          id: `call_${name}`,
          name,
          arguments: {},
        })),
      },
      { text: "recovered" },
    ])
    await using(driver, { provider, tools }, async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({
        status: "idle",
        reason: "stop_on_response",
        steps: 2,
      })
      const results = toolResults(await session.messages(thread))
      expect(results.map((m) => [m.name, m.tool_call_id, m.tool_status, m.status])).toEqual([
        ["soft", "call_soft", "error", "completed"],
        ["boom", "call_boom", "error", "completed"],
        ["reject", "call_reject", "error", "completed"],
        ["weird", "call_weird", "error", "completed"],
        ["fine", "call_fine", "success", "completed"],
      ])
      expect(results.map((m) => m.content)).toEqual([
        "soft fail",
        "Tool boom threw: kaboom",
        "Tool reject threw: rejected",
        'Tool weird threw: {"reason":42}',
        "fine",
      ])
    })
    const followUp = history(provider.requests[1]).filter((message) => message.role === "tool")
    expect(followUp.map((m) => (m.role === "tool" ? [m.toolCallId, m.toolName, typeof m.content] : []))).toEqual([
      ["call_soft", "soft", "object"],
      ["call_boom", "boom", "object"],
      ["call_reject", "reject", "object"],
      ["call_weird", "weird", "object"],
      ["call_fine", "fine", "string"],
    ])
    expect(followUp[0]?.role === "tool" ? followUp[0].content : undefined).toEqual({
      type: "error",
      error: "soft fail",
    })
  },
}

export const S14b: Scenario = {
  name: "S14b stores a tool error that keeps the tool's text for a result that cannot be stored, and runs the next call",
  requirements: ["732b2d4b"],
  run: async (driver) => {
    const tools = {
      tangled: defineTool({
        description: "Returns circular diagnostic data",
        execute: async () => {
          const data: Record<string, unknown> = {}
          data.self = data
          return { status: "error" as const, error: "tangled", error_code: "loop", error_data: data }
        },
      }),
      hollow: defineTool({
        description: "Returns a null attachment",
        execute: async () => ({ status: "success" as const, result: "partial", attachments: [null] }) as never,
      }),
      reference: defineTool({
        description: "Returns an unreadable attachment",
        execute: async () => ({
          status: "success" as const,
          attachments: [
            {
              id: "file",
              type: "file" as const,
              path: "/file",
              mimeType: "text/plain",
              size: 1,
              get name(): string {
                throw new Error("no name")
              },
            },
          ],
        }),
      }),
      guarded: defineTool({
        description: "Returns error data whose getter throws",
        execute: async () => ({
          status: "error" as const,
          error: "guarded",
          error_data: {
            get secret() {
              throw new Error("no access")
            },
          },
        }),
      }),
      prickly: defineTool({
        description: "Returns a result whose getter throws",
        execute: async () =>
          ({
            status: "success",
            get result() {
              throw new Error("no result")
            },
          }) as never,
      }),
      thrower: defineTool({
        description: "Throws a plain object",
        execute: async () => {
          throw { reason: "quota", retry: false }
        },
      }),
      fine: stubTool("Returns at once", "fine"),
    }
    const names = ["tangled", "hollow", "guarded", "reference", "prickly", "thrower", "fine"]
    const provider = new ScriptedProvider([
      { toolCalls: names.map((name) => ({ id: `c_${name}`, name, arguments: {} })) },
      { text: "recovered" },
    ])
    await using(driver, { provider, tools }, async (session, thread) => {
      const outcome = await session.send(thread, "go")
      expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
      const results = toolResults(await session.messages(thread))
      expect(results.map((m) => [m.tool_call_id, m.name, m.tool_status, m.content, m.attachments, m.metadata])).toEqual(
        [
          [
            "c_tangled",
            "tangled",
            "error",
            "tangled\n\nSpindle dropped the error data of this result, because the message metadata holds a circular reference at $.error_data.self.self, which JSON cannot represent",
            null,
            { error_code: "loop" },
          ],
          [
            "c_hollow",
            "hollow",
            "error",
            "partial\n\nSpindle dropped 1 attachment that is neither a file reference nor a new file.",
            null,
            {},
          ],
          [
            "c_guarded",
            "guarded",
            "error",
            "guarded\n\nSpindle dropped the error data of this result, because reading it threw: no access",
            null,
            {},
          ],
          [
            "c_reference",
            "reference",
            "error",
            "Spindle dropped the attachments of this result, because reading it threw: no name",
            null,
            {},
          ],
          ["c_prickly", "prickly", "error", "Reading the result of tool prickly threw: no result", null, {}],
          ["c_thrower", "thrower", "error", 'Tool thrower threw: {"reason":"quota","retry":false}', null, {}],
          ["c_fine", "fine", "success", "fine", null, {}],
        ],
      )
    })
    expect(history(provider.requests[1]).map(sideOf)).toEqual([
      ["user", "go"],
      ["assistant", null, names.map((name) => `c_${name}`)],
      ...names.map((name) => ["tool", `c_${name}`]),
    ])
  },
}

export const S14c: Scenario = {
  name: "S14c drops class-instance error data and explains the loss in the stored result",
  requirements: ["732b2d4b"],
  run: async (driver) => {
    class Details {
      readonly [key: string]: unknown
      readonly internal = "private detail"
      toJSON() {
        return { summary: "public detail" }
      }
    }
    let reads = 0
    const shared = {
      get code() {
        return ++reads
      },
    }
    Object.setPrototypeOf(shared, null)
    const data = {
      top: new Details(),
      nested: { list: [{ details: new Details() }] },
      plain: {
        list: Object.assign([shared, shared, null, false, 0, ""], { annotation: new Details() }),
        ["__proto__"]: "ordinary key",
        absent: undefined,
      },
    }
    const diagnostic = defineTool({
      description: "Return diagnostic data",
      args: z.object({ variant: z.enum(["top", "nested", "plain"]) }),
      execute: async (_state, { variant }) => ({
        status: "error",
        error: "denied",
        error_code: "quota",
        error_data: data[variant],
      }),
    })
    const provider = new ScriptedProvider([
      { toolCalls: Object.keys(data).map((variant) => ({ id: variant, name: "diagnostic", arguments: { variant } })) },
      { text: "done" },
    ])
    await using(driver, { provider, tools: { diagnostic } }, async (session, thread) => {
      await session.send(thread, "go")
      const results = toolResults(await session.messages(thread))
      expect(reads).toBe(1)
      expect(results[2]?.metadata).toEqual({
        error_code: "quota",
        error_data: { list: [{ code: 1 }, { code: 1 }, null, false, 0, ""], ["__proto__"]: "ordinary key" },
      })
      for (const row of results.slice(0, 2)) {
        expect(row.tool_status).toBe("error")
        expect(row.content).toContain("denied\n\nSpindle dropped the error data")
        expect(row.metadata).toEqual({ error_code: "quota" })
      }
    })
  },
}

export const S15: Scenario = {
  name: "S15 accepts every legal ToolResult shape, keeps attachment references, and rejects other returns",
  requirements: ["50d12acc", "1d6d311a", "39260b1a"],
  run: async (driver) => {
    const chart = {
      id: "att_1",
      type: "file" as const,
      path: "/attachments/chart.png",
      name: "chart.png",
      mimeType: "image/png",
      size: 2048,
      width: 640,
      height: 480,
      description: "A bar chart",
    }
    const notes = {
      id: "att_2",
      type: "file" as const,
      path: "/attachments/notes.txt",
      name: "notes.txt",
      mimeType: "text/plain",
      size: 12,
    }
    const fresh = { name: "new.png", mimeType: "image/png", data: "iVBORw0KGgo=" }
    const variants: Record<string, unknown> = {
      status_only: { status: "success" },
      error_only: { status: "error" },
      empty: { status: "success", result: "" },
      both: { status: "error", error: "broke", result: "partial" },
      structured: {
        status: "error",
        error: "denied",
        error_code: "quota",
        error_data: { limit: 3 },
        stack: "STACK-SENTINEL",
      },
      no_attachments: { status: "success", result: "none", attachments: [] },
      refs: { status: "success", result: "two files", attachments: [chart, notes] },
      new_file: { status: "success", result: "made one", attachments: [fresh] },
      mixed: { status: "success", result: "mixed", attachments: [chart, fresh] },
      bare_string: "just text",
      array: [1, 2],
      object: { foo: 1 },
      unknown_status: { status: "maybe" },
    }
    const names = Object.keys(variants)
    const tools = {
      shape: defineTool({
        description: "Returns a shape",
        args: z.object({ variant: z.string() }),
        execute: async (_state, { variant }) => variants[variant] as never,
      }),
      inspect: defineTool({
        description: "Invokes shape directly",
        uses: ["shape"] as Array<string>,
        execute: async (state: ThreadState) =>
          ok(
            JSON.stringify(
              await Promise.all(["structured", "refs"].map((variant) => state.invokeTool("shape", { variant }))),
            ),
          ),
      }),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          ...names.map((variant) => ({ id: variant, name: "shape", arguments: { variant } })),
          { id: "inspect", name: "inspect", arguments: {} },
        ],
      },
      { text: "done" },
    ])
    await using(driver, { provider, tools }, async (session, thread) => {
      await session.send(thread, "go")
      const results = Object.fromEntries(toolResults(await session.messages(thread)).map((m) => [m.tool_call_id, m]))
      const row = (id: string) => [
        results[id]?.tool_status,
        results[id]?.content,
        results[id]?.attachments,
        results[id]?.metadata,
      ]
      expect(row("status_only")).toEqual(["success", "", null, {}])
      expect(row("error_only")).toEqual(["error", "", null, {}])
      expect(row("empty")).toEqual(["success", "", null, {}])
      expect(row("both")).toEqual(["error", "broke\n\npartial", null, {}])
      expect(row("structured")).toEqual(["error", "denied", null, { error_code: "quota", error_data: { limit: 3 } }])
      expect(row("no_attachments")).toEqual(["success", "none", null, {}])
      expect(row("refs")).toEqual(["success", "two files", [chart, notes], {}])
      for (const id of ["new_file", "mixed"]) {
        expect(results[id]?.tool_status).toBe("error")
        expect(results[id]?.content).toContain("M3")
      }
      for (const id of ["bare_string", "array", "object", "unknown_status"]) {
        expect(results[id]?.tool_status).toBe("error")
        expect(results[id]?.content).toContain("not a ToolResult")
      }
      const structured = history(provider.requests[1]).find((m) => m.role === "tool" && m.toolCallId === "structured")
      expect(structured).toEqual({
        role: "tool",
        toolCallId: "structured",
        toolName: "shape",
        content: { type: "error", error: "denied" },
      })
      expect(JSON.stringify(results.structured)).not.toContain("STACK-SENTINEL")
      expect(JSON.parse(results.inspect?.content ?? "null")).toEqual([variants.structured, variants.refs])
    })
  },
}

export const S16: Scenario = {
  name: "S16 answers a call to an unoffered or unknown tool with an error result and enforces uses in invokeTool",
  requirements: ["732b2d4b", "dc9a10a7", "a403d2a5", "39260b1a"],
  run: async (driver) => {
    const hidden = counter()
    const asState = (state: unknown) => state as ThreadState
    const tools = {
      visible: stubTool("Offered", "visible ran"),
      hidden: defineTool({ description: "Not offered", execute: async () => hidden.tick(ok("hidden ran")) }),
      limited: defineTool({
        description: "Uses only visible",
        uses: ["visible"] as Array<string>,
        execute: async (state) => ok(JSON.stringify(await asState(state).invokeTool("hidden", {}))),
      }),
      closed: defineTool({
        description: "Uses nothing",
        uses: [] as Array<string>,
        execute: async (state) => ok(JSON.stringify(await asState(state).invokeTool("visible", {}))),
      }),
      open: defineTool({
        description: "Declares no uses",
        execute: async (state: ThreadState) => ok(JSON.stringify(await state.invokeTool("hidden", {}))),
      }),
    }
    const provider = new ScriptedProvider([
      {
        toolCalls: [
          { id: "c_hidden", name: "hidden", arguments: {} },
          { id: "c_ghost", name: "ghost", arguments: {} },
          { id: "c_visible", name: "visible", arguments: {} },
        ],
      },
      {
        toolCalls: [
          { id: "c_limited", name: "limited", arguments: {} },
          { id: "c_closed", name: "closed", arguments: {} },
          { id: "c_open", name: "open", arguments: {} },
        ],
      },
      { text: "done" },
    ])
    await using(
      driver,
      { provider, tools, prompt: { tools: ["visible", "limited", "closed", "open"] } },
      async (session, thread) => {
        const running = session.send(thread, "go")
        const outcome = await running
        expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 3 })
        const results = Object.fromEntries(toolResults(await session.messages(thread)).map((m) => [m.tool_call_id, m]))
        expect([results.c_hidden?.name, results.c_hidden?.tool_status]).toEqual(["hidden", "error"])
        expect(results.c_hidden?.content).toContain("does not offer")
        expect([results.c_ghost?.name, results.c_ghost?.tool_status]).toEqual(["ghost", "error"])
        expect(results.c_visible?.content).toBe("visible ran")
        expect(JSON.parse(results.c_limited?.content ?? "{}")).toMatchObject({ status: "error" })
        expect(JSON.parse(results.c_limited?.content ?? "{}").error).toContain("uses")
        expect(JSON.parse(results.c_closed?.content ?? "{}")).toMatchObject({ status: "error" })
        expect(JSON.parse(results.c_open?.content ?? "{}")).toEqual({ status: "success", result: "hidden ran" })
      },
    )
    expect(provider.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual([
      "visible",
      "limited",
      "closed",
      "open",
    ])
    expect(hidden.count).toBe(1)
  },
}

export const S23: Scenario = {
  name: "S23 ignores tool annotations in the request, the validation, the execution, and the result",
  requirements: ["3bb2444c", "e2d0db94", "20a428b9", "cfce7619"],
  run: async (driver) => {
    const runWith = async (annotations: Record<string, unknown> | undefined) => {
      const provider = new ScriptedProvider([
        { toolCalls: [{ id: "c1", name: "echo", arguments: { text: "hi" } }] },
        { toolCalls: [{ id: "c2", name: "echo", arguments: { text: 3 } }] },
        { text: "done" },
      ])
      const tools = {
        echo: defineTool({
          description: "Echo",
          args: z.object({ text: z.string() }),
          ...(annotations === undefined ? {} : { annotations }),
          execute: async (_state, { text }) => ok(text),
        }),
      }
      let stored: Array<unknown> = []
      await using(driver, { provider, tools }, async (session, thread) => {
        await session.send(thread, "go")
        stored = (await session.messages(thread)).map((m) => [m.role, m.content, m.tool_status, m.tool_calls])
      })
      return { requests: JSON.stringify(provider.requests), stored }
    }
    const plain = await runWith(undefined)
    const annotated = await runWith({
      spindle_test: { sentinel: "ANNOTATION-SENTINEL" },
      someone_else: { codemode: { codeArgument: "text" } },
    })
    expect(annotated.requests).toBe(plain.requests)
    expect(annotated.stored).toEqual(plain.stored)
    expect(annotated.requests).not.toContain("ANNOTATION-SENTINEL")
  },
}
