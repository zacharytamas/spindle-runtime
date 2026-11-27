import { describe, expect, it } from "@effect/vitest"
import { defineTool, type ExecutionState, type SkillsNamespace, type ThreadState } from "@standardagents/spec"
import { ConfigProvider, Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { expectTypeOf } from "vitest"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { ok, project, stubTool, using } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, stateAtRest } from "../../src/execution/trigger.ts"
import { registryOf, spindleDriver } from "../spindle-driver.ts"
import { inMemory } from "../store/contract-fixtures.ts"

const methods = [
  "getMessages",
  "getMessage",
  "injectMessage",
  "updateMessage",
  "deleteMessage",
  "queueMessage",
  "loadModel",
  "loadPrompt",
  "loadAgent",
  "getPromptNames",
  "getAgentNames",
  "getModelNames",
  "getChildThread",
  "getParentThread",
  "env",
  "instanceEnv",
  "envType",
  "setEnv",
  "notifyParent",
  "setStatus",
  "stopSession",
  "queueTool",
  "invokeTool",
  "scheduleEffect",
  "getScheduledEffects",
  "removeScheduledEffect",
  "runAgent",
  "terminate",
  "emit",
  "getValue",
  "setValue",
  "getUserValue",
  "setUserValue",
  "listUserValues",
  "user",
  "writeFile",
  "readFile",
  "readFileStream",
  "statFile",
  "readdirFile",
  "unlinkFile",
  "mkdirFile",
  "rmdirFile",
  "moveFile",
  "renameFile",
  "getFileStats",
  "grepFiles",
  "findFiles",
  "getFileThumbnail",
  "status",
  "decide",
  "runCode",
] as const
const fields = [
  "threadId",
  "agentId",
  "userId",
  "createdAt",
  "children",
  "terminated",
  "arguments",
  "execution",
  "context",
  "skills",
] as const
const skillMethods = ["list", "get", "readFile", "install", "setEnabled", "remove"] as const
const executionMembers = [
  "flowId",
  "currentSide",
  "stepCount",
  "sideAStepCount",
  "sideBStepCount",
  "stopped",
  "stoppedBy",
  "messageHistory",
  "forceTurn",
  "stop",
  "abortSignal",
  "promptPath",
] as const

// Threads section 11.3 (specification/threads.md:602-604): a method that returns a promise throws on invalid
// parameters, so the call returns a promise and the promise rejects. A synchronous throw, a resolution, a storage
// error, or a crash on the wrong type inside the method does not count as a refusal.
async function refusal(call: () => unknown): Promise<string> {
  let returned: unknown
  try {
    returned = call()
  } catch (cause) {
    return `threw synchronously: ${String(cause)}`
  }
  if (!(returned instanceof Promise)) return `returned ${String(returned)}, not a promise`
  try {
    return `resolved ${JSON.stringify(await returned)}`
  } catch (cause) {
    const tag = typeof cause === "object" && cause !== null ? Reflect.get(cause, "_tag") : undefined
    if (tag === "SqlError") return "rejected with a storage error"
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/is not a function|Cannot read properties|Cannot destructure|is not iterable/.test(message))
      return `crashed: ${message}`
    return "refused"
  }
}

const refusals = async (calls: Record<string, () => unknown>) => {
  const outcomes: Record<string, string> = {}
  for (const [name, call] of Object.entries(calls)) outcomes[name] = await refusal(call)
  return outcomes
}

const allRefused = (calls: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(calls).map((name) => [name, "refused"]))

function members(value: object) {
  const keys = new Set<PropertyKey>(Reflect.ownKeys(value))
  for (
    let parent = Object.getPrototypeOf(value);
    parent && parent !== Object.prototype;
    parent = Object.getPrototypeOf(parent)
  ) {
    for (const key of Reflect.ownKeys(parent)) if (key !== "constructor") keys.add(key)
  }
  return [...keys].map(String).sort()
}

describe("ThreadState", () => {
  it("exposes only the public spec members at rest and inside a tool", async () => {
    expectTypeOf<keyof ThreadState>().toEqualTypeOf<
      (typeof methods)[number] | (typeof fields)[number] | "runtimeStreams" | "_notPackableRuntimeContext"
    >()
    expectTypeOf<keyof ExecutionState>().toEqualTypeOf<(typeof executionMembers)[number]>()
    expectTypeOf<keyof SkillsNamespace>().toEqualTypeOf<(typeof skillMethods)[number]>()
    const inspect = (state: ThreadState) => ({
      state: members(state),
      skills: members(state.skills),
      execution: state.execution && members(state.execution),
      nonFunctions: [
        ...methods.filter((name) => typeof state[name] !== "function"),
        ...skillMethods.filter((name) => typeof state.skills[name] !== "function"),
      ],
    })
    let active: ReturnType<typeof inspect> | undefined
    const survey = defineTool({
      description: "Inspect the thread handle",
      execute: async (state: ThreadState) => {
        active = inspect(state)
        return ok("done")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "survey", arguments: {} }] }, { text: "done" }])
    await using(spindleDriver, { provider, tools: { survey } }, async (session, thread) => {
      const expected = {
        state: [...fields, ...methods].sort(),
        skills: [...skillMethods].sort(),
        execution: null,
        nonFunctions: [],
      }
      expect(inspect(await session.state(thread))).toEqual(expected)
      await session.send(thread, "go")
      expect(active).toEqual({
        ...expected,
        execution: [...executionMembers].sort(),
      })
    })
  })

  it("returns the documented empty values on an unused root thread", async () => {
    await using(spindleDriver, { provider: new ScriptedProvider([]) }, async (session, thread) => {
      const state = await session.state(thread)
      expect(await state.getMessages()).toEqual({ messages: [], total: 0, hasMore: false })
      expect(await state.getMessage("missing")).toBeNull()
      expect(await state.deleteMessage("missing")).toBe(false)
      expect(await state.getValue("missing")).toBeNull()
      expect(await state.getChildThread("missing")).toBeNull()
      expect(await state.getParentThread()).toBeNull()
      expect(state.children).toEqual([])
      expect(await state.user()).toBeNull()
      expect(await state.envType("missing")).toBe("secret")
    })
  })

  it("lists no definition names when the registry is empty", async () => {
    const session = await spindleDriver.load({ agents: [], prompts: [], models: [] })
    try {
      const state = await session.state(await session.createThread("assistant"))
      expect(state.getAgentNames()).toEqual([])
      expect(state.getPromptNames()).toEqual([])
      expect(state.getModelNames()).toEqual([])
    } finally {
      await session.close()
    }
  })

  it("accepts omitted message options and distinguishes an absent instance variable from a required lookup", async () => {
    await using(spindleDriver, { provider: new ScriptedProvider([]) }, async (session, thread) => {
      const state = await session.state(thread)
      expect(await state.setStatus("ready")).toBeUndefined()
      const message = await state.injectMessage({ role: "user", content: "note" })
      expect(message).toMatchObject({ silent: false, metadata: {}, prompt: null })
      expect((await state.getMessages()).messages).toEqual([message])
      expect(await state.updateMessage(message.id, {})).toEqual(message)
      expect(state.instanceEnv).toBeTypeOf("function")
      expect(await state.instanceEnv?.("missing")).toBeUndefined()
      await expect(state.env("missing")).rejects.toThrow("has no value")
    })
  })

  it("rejects invalid pagination, keys, non-JSON values and unknown definition names", async () => {
    await using(spindleDriver, { provider: new ScriptedProvider([]) }, async (session, thread) => {
      const state = await session.state(thread)
      await expect(Reflect.apply(state.queueMessage, state, [{ role: "system", content: "go" }])).rejects.toMatchObject(
        { _tag: "QueueRefused" },
      )
      expect(() => Reflect.apply(state.queueTool, state, ["noop", null])).toThrow(
        expect.objectContaining({ _tag: "InvalidArguments" }),
      )
      for (const options of [{ limit: -1 }, { offset: -1 }, { maxDepth: -1 }])
        await expect(state.getMessages(options)).rejects.toMatchObject({ _tag: "InvalidMessagesQuery" })
      await expect(state.getValue("\ud800")).rejects.toMatchObject({ _tag: "KeyNotWellFormed" })
      await expect(state.setValue("\ud800", 1)).rejects.toMatchObject({ _tag: "KeyNotWellFormed" })
      await expect(state.setValue("bad", Infinity)).rejects.toMatchObject({ _tag: "ValueNotJson" })
      await expect(state.loadModel("absent")).rejects.toThrow("No model named absent")
      await expect(state.loadPrompt("absent")).rejects.toThrow("No prompt named absent")
      await expect(state.loadAgent("absent")).rejects.toThrow("No agent named absent")
    })
  })

  it.effect("propagates SQLite failures through every M1 storage-backed operation", () =>
    Effect.gen(function* () {
      const { id } = yield* createThread("assistant")
      const state = yield* stateAtRest(id)
      const sql = yield* SqlClient
      yield* sql`ALTER TABLE messages RENAME TO offline_messages`
      yield* sql`ALTER TABLE kv RENAME TO offline_kv`
      yield* sql`ALTER TABLE threads RENAME TO offline_threads`
      yield* Effect.promise(async () => {
        const operations = {
          getMessages: () => state.getMessages(),
          getMessage: () => state.getMessage("id"),
          injectMessage: () => state.injectMessage({ role: "user", content: "note" }),
          updateMessage: () => state.updateMessage("id", { content: "new" }),
          deleteMessage: () => state.deleteMessage("id"),
          getValue: () => state.getValue("key"),
          setValue: () => state.setValue("key", "value"),
          queueMessage: () => state.queueMessage({ role: "user", content: "go" }),
          status: () => state.status(),
          terminate: () => state.terminate(),
        }
        for (const [name, invoke] of Object.entries(operations))
          await expect(invoke(), name).rejects.toMatchObject({ _tag: "SqlError" })
        expect(() => state.queueTool("noop", {})).toThrow(expect.objectContaining({ _tag: "SqlError" }))
      })
    }).pipe(
      Effect.provide(
        Layer.merge(
          registryOf(project({ provider: new ScriptedProvider([]), tools: { noop: stubTool("Do nothing", "ok") } })),
          Layer.provideMerge(supervisorLayer(), inMemory),
        ),
      ),
    ),
  )

  // Threads section 2.3 (specification/threads.md:227-230): instanceEnv "returns `undefined` when the key is not
  // configured and rejects when the runtime cannot read its instance environment". One provider serves all three keys,
  // so the rejection comes from the failing read and from nothing else in the setup.
  it.effect("instanceEnv rejects when its configuration source fails and resolves undefined for an absent key", () =>
    Effect.gen(function* () {
      const { id } = yield* createThread("assistant")
      const state = yield* stateAtRest(id)
      yield* Effect.promise(async () => {
        const settle = (name: string) =>
          (state.instanceEnv?.(name) ?? Promise.resolve("no instanceEnv")).then(
            (value) => ({ resolved: value }),
            () => ({ rejected: true }),
          )
        expect(await settle("SPINDLE_PRESENT")).toEqual({ resolved: "present value" })
        expect(await settle("SPINDLE_ABSENT")).toEqual({ resolved: undefined })
        expect(await settle("SPINDLE_UNREADABLE")).toEqual({ rejected: true })
        await expect(state.env("SPINDLE_UNREADABLE")).rejects.toThrow("read failed")
        await expect(state.env("SPINDLE_ABSENT")).rejects.toThrow("has no value")
      })
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryOf(project({ provider: new ScriptedProvider([]) })),
          Layer.provideMerge(supervisorLayer(), inMemory),
          ConfigProvider.layer(
            ConfigProvider.make((path) =>
              path[0] === "SPINDLE_UNREADABLE"
                ? Effect.fail(new ConfigProvider.SourceError({ message: "the configuration store is offline" }))
                : Effect.succeed(path[0] === "SPINDLE_PRESENT" ? ConfigProvider.makeValue("present value") : undefined),
            ),
          ),
        ),
      ),
    ),
  )

  // Only the read that a caller asks for rejects. A variable that a prompt declares and nobody reads must not fail
  // the creation of a thread, which has stored its row by then, or a run that never uses the variable.
  it.effect("creates a thread and runs it when a declared variable that nothing reads cannot be read", () =>
    Effect.gen(function* () {
      const { id } = yield* createThread("assistant")
      const state = yield* stateAtRest(id)
      yield* Effect.promise(async () => expect(await state.getMessages()).toMatchObject({ messages: [] }))
      const supervisor = yield* ThreadSupervisor
      expect((yield* supervisor.send(id, "go")).outcome).toMatchObject({ status: "idle", steps: 1 })
      const sql = yield* SqlClient
      expect(yield* sql`SELECT count(*) AS threads FROM threads`).toEqual([{ threads: 1 }])
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          registryOf(
            project({
              provider: new ScriptedProvider([{ text: "done" }]),
              prompt: {
                variables: [{ name: "SPINDLE_UNREADABLE", type: "text", required: false, description: "Never read" }],
              },
            }),
          ),
          Layer.provideMerge(supervisorLayer(), inMemory),
          ConfigProvider.layer(
            ConfigProvider.make((path) =>
              path[0] === "SPINDLE_UNREADABLE"
                ? Effect.fail(new ConfigProvider.SourceError({ message: "the configuration store is offline" }))
                : Effect.succeed(undefined),
            ),
          ),
        ),
      ),
    ),
  )

  it("refuses an unknown message order and reads each legal order", async () => {
    await using(spindleDriver, { provider: new ScriptedProvider([]) }, async (session, thread) => {
      const state = await session.state(thread)
      const first = await state.injectMessage({ role: "user", content: "first" })
      const second = await state.injectMessage({ role: "user", content: "second" })
      const ids = async (options?: Parameters<ThreadState["getMessages"]>[0]) =>
        (await state.getMessages(options)).messages.map((message) => message.id)
      // Messages section 2.1 (specification/threads/messages.md:98): order is 'asc' or 'desc', and 'desc' is the default.
      expect(await ids({ order: "asc" })).toEqual([first.id, second.id])
      expect(await ids({ order: "desc" })).toEqual([second.id, first.id])
      expect(await ids({})).toEqual([second.id, first.id])
      expect(await ids()).toEqual([second.id, first.id])
      const calls = {
        sideways: () => Reflect.apply(state.getMessages, state, [{ order: "sideways" }]),
        uppercase: () => Reflect.apply(state.getMessages, state, [{ order: "ASC" }]),
        number: () => Reflect.apply(state.getMessages, state, [{ order: 1 }]),
      }
      expect(await refusals(calls)).toEqual(allRefused(calls))
    })
  })

  it("refuses a message id or a value key that is not a string", async () => {
    await using(spindleDriver, { provider: new ScriptedProvider([]) }, async (session, thread) => {
      const state = await session.state(thread)
      const message = await state.injectMessage({ role: "user", content: "kept" })
      const doomed = await state.injectMessage({ role: "user", content: "deleted" })
      // The package declares getMessage(messageId: string), deleteMessage(messageId: string),
      // updateMessage(messageId: string, ...), getValue(key: string) and setValue(key: string, value).
      const calls = {
        "getMessage()": () => Reflect.apply(state.getMessage, state, []),
        "getMessage(42)": () => Reflect.apply(state.getMessage, state, [42]),
        "getMessage(null)": () => Reflect.apply(state.getMessage, state, [null]),
        "deleteMessage(42)": () => Reflect.apply(state.deleteMessage, state, [42]),
        "deleteMessage(null)": () => Reflect.apply(state.deleteMessage, state, [null]),
        "updateMessage(42)": () => Reflect.apply(state.updateMessage, state, [42, { content: "x" }]),
        "getValue(42)": () => Reflect.apply(state.getValue, state, [42]),
        "getValue(null)": () => Reflect.apply(state.getValue, state, [null]),
        "setValue(42)": () => Reflect.apply(state.setValue, state, [42, "stored"]),
        "setValue(null)": () => Reflect.apply(state.setValue, state, [null, "stored"]),
      }
      expect(await refusals(calls)).toEqual(allRefused(calls))
      // A refused write stores nothing under the key that the number or null would become as text.
      expect(await state.getValue("42")).toBeNull()
      expect(await state.getValue("null")).toBeNull()
      expect(await state.getMessage(message.id)).toEqual(message)
      expect(await state.deleteMessage(doomed.id)).toBe(true)
      expect(await state.getMessage(doomed.id)).toBeNull()
      await state.setValue("key", "value")
      expect(await state.getValue("key")).toBe("value")
    })
  })

  it("rejects injectMessage(null) through its promise instead of throwing", async () => {
    await using(spindleDriver, { provider: new ScriptedProvider([]) }, async (session, thread) => {
      const state = await session.state(thread)
      // The package declares injectMessage(input: InjectMessageInput): Promise<Message>.
      const calls = {
        "injectMessage(null)": () => Reflect.apply(state.injectMessage, state, [null]),
        "injectMessage()": () => Reflect.apply(state.injectMessage, state, []),
        "injectMessage(text)": () => Reflect.apply(state.injectMessage, state, ["hello"]),
      }
      expect(await refusals(calls)).toEqual(allRefused(calls))
      expect((await state.getMessages()).total).toBe(0)
      const message = await state.injectMessage({ role: "user", content: "legal" })
      expect((await state.getMessages()).messages).toEqual([message])
    })
  })

  it("refuses wrong-typed message options, inputs and updates and stores nothing for them", async () => {
    await using(spindleDriver, { provider: new ScriptedProvider([]) }, async (session, thread) => {
      const state = await session.state(thread)
      const message = await state.injectMessage({ role: "user", content: "kept", metadata: { a: 1 } })
      // The package declares GetMessagesOptions { includeSilent?: boolean, ... }, InjectMessageInput { role: 'user' |
      // 'assistant' | 'system', content: string, silent?: boolean, metadata?: Record<string, unknown> }, and
      // MessageUpdates { content?: string, metadata?: Record<string, unknown> }.
      const calls = {
        "getMessages(null)": () => Reflect.apply(state.getMessages, state, [null]),
        "getMessages(text)": () => Reflect.apply(state.getMessages, state, ["recent"]),
        "getMessages(includeSilent text)": () => Reflect.apply(state.getMessages, state, [{ includeSilent: "yes" }]),
        "injectMessage(role wrong)": () => Reflect.apply(state.injectMessage, state, [{ role: "wrong", content: "x" }]),
        "injectMessage(number content)": () =>
          Reflect.apply(state.injectMessage, state, [{ role: "user", content: 42 }]),
        "injectMessage(role tool)": () => Reflect.apply(state.injectMessage, state, [{ role: "tool", content: "x" }]),
        "injectMessage(silent text)": () =>
          Reflect.apply(state.injectMessage, state, [{ role: "user", content: "x", silent: "yes" }]),
        "injectMessage(metadata number)": () =>
          Reflect.apply(state.injectMessage, state, [{ role: "user", content: "x", metadata: 42 }]),
        "updateMessage(id, number content)": () =>
          Reflect.apply(state.updateMessage, state, [message.id, { content: 42 }]),
        "updateMessage(id, null)": () => Reflect.apply(state.updateMessage, state, [message.id, null]),
        "injectMessage(metadata array)": () =>
          Reflect.apply(state.injectMessage, state, [{ role: "user", content: "x", metadata: ["x"] }]),
        "updateMessage(id, metadata array)": () =>
          Reflect.apply(state.updateMessage, state, [message.id, { metadata: ["x"] }]),
        "updateMessage(id, metadata number)": () =>
          Reflect.apply(state.updateMessage, state, [message.id, { metadata: 42 }]),
      }
      expect(await refusals(calls)).toEqual(allRefused(calls))
      expect((await state.getMessages({ includeSilent: true })).messages).toEqual([message])
      const silent = await state.injectMessage({ role: "system", content: "s", silent: true, metadata: { b: 2 } })
      expect((await state.getMessages({ includeSilent: false })).messages).toEqual([message])
      expect((await state.getMessages({ includeSilent: true })).total).toBe(2)
      expect(await state.updateMessage(silent.id, { metadata: { c: 3 } })).toMatchObject({
        metadata: { b: 2, c: 3 },
      })
    })
  })

  it("refuses wrong-typed names on getChildThread, instanceEnv, envType and setStatus", async () => {
    await using(spindleDriver, { provider: new ScriptedProvider([]) }, async (session, thread) => {
      const state = await session.state(thread)
      // The package declares getChildThread(referenceId: string), instanceEnv?(propertyName: string),
      // envType(propertyName: string) and setStatus(status: string).
      const calls = {
        "loadModel(42)": () => Reflect.apply(state.loadModel, state, [42]),
        "loadAgent(null)": () => Reflect.apply(state.loadAgent, state, [null]),
        "env(42)": () => Reflect.apply(state.env, state, [42]),
        "instanceEnv(42)": () => Reflect.apply(state.instanceEnv ?? (() => undefined), state, [42]),
        "getChildThread(42)": () => Reflect.apply(state.getChildThread, state, [42]),
        "getChildThread()": () => Reflect.apply(state.getChildThread, state, []),
        "instanceEnv(null)": () => Reflect.apply(state.instanceEnv ?? (() => undefined), state, [null]),
        "envType(42)": () => Reflect.apply(state.envType, state, [42]),
        "setStatus(42)": () => Reflect.apply(state.setStatus, state, [42]),
        "setStatus()": () => Reflect.apply(state.setStatus, state, []),
      }
      expect(await refusals(calls)).toEqual(allRefused(calls))
      expect(await state.getChildThread("missing")).toBeNull()
      expect(await state.instanceEnv?.("SPINDLE_TEST_ABSENT_VARIABLE")).toBeUndefined()
      expect(await state.envType("missing")).toBe("secret")
      expect(await state.setStatus("ready")).toBeUndefined()
      // setStatus(status: string): the empty string is a string, and threads.md:542 makes the call a no-op here.
      expect(await state.setStatus("")).toBeUndefined()
    })
  })

  it("refuses invokeTool arguments that are not an object inside a calling tool", async () => {
    let outcomes: Record<string, string> = {}
    let legal: Array<unknown> = []
    const caller = defineTool({
      description: "Invoke noop with each kind of arguments",
      uses: ["noop"] as Array<string>,
      execute: async (state: ThreadState) => {
        // Threads section 12 declares invokeTool(toolName: string, args: Record<string, unknown>), and the package
        // lets a tool with a uses list leave the arguments out. Tools section 2.1 (specification/tools.md:44) turns
        // only an undeclared target into an error result, so wrong-typed arguments reject.
        outcomes = await refusals({
          "invokeTool(42, {})": () => Reflect.apply(state.invokeTool, state, [42, {}]),
          "invokeTool(noop, null)": () => Reflect.apply(state.invokeTool, state, ["noop", null]),
          "invokeTool(noop, 42)": () => Reflect.apply(state.invokeTool, state, ["noop", 42]),
          "invokeTool(noop, [])": () => Reflect.apply(state.invokeTool, state, ["noop", []]),
          "invokeTool(noop, text)": () => Reflect.apply(state.invokeTool, state, ["noop", "text"]),
        })
        legal = [await state.invokeTool("noop", {}), await Reflect.apply(state.invokeTool, state, ["noop"])]
        return ok("done")
      },
    })
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "caller", arguments: {} }] }, { text: "done" }])
    await using(
      spindleDriver,
      { provider, tools: { caller, noop: stubTool("Do nothing", "ok") }, prompt: { tools: ["caller"] } },
      async (session, thread) => {
        await session.send(thread, "go")
        expect(outcomes).toEqual(
          allRefused({
            "invokeTool(42, {})": 0,
            "invokeTool(noop, null)": 0,
            "invokeTool(noop, 42)": 0,
            "invokeTool(noop, [])": 0,
            "invokeTool(noop, text)": 0,
          }),
        )
        expect(legal).toEqual([
          { status: "success", result: "ok" },
          { status: "success", result: "ok" },
        ])
      },
    )
  })
})
