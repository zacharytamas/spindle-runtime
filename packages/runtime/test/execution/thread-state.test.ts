import { describe, expect, it } from "@effect/vitest"
import { defineTool, type ExecutionState, type SkillsNamespace, type ThreadState } from "@standardagents/spec"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { expectTypeOf } from "vitest"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { ok, project, stubTool, using } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer } from "../../src/execution/ThreadSupervisor.ts"
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
})
