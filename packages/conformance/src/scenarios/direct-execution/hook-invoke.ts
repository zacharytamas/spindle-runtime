import {
  defineAgent,
  defineHook,
  defineModel,
  definePrompt,
  defineTool,
  type ThreadState,
  type ToolResult,
} from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import type { RuntimeDriver } from "../../RuntimeDriver.ts"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { executionSnapshot, handlerOf } from "../handlers/fixtures.ts"
import { attempt, ok, type Scenario, stubTool, toolResults } from "../harness.ts"
import { STORAGE_HOOK_IDS, storageHooks, usingDirect } from "./fixtures.ts"

const runPromptAndDeliveryHookInvoke = async (driver: RuntimeDriver) => {
  const firedStorage: Array<string> = []
  const seen: Array<Record<string, unknown>> = []
  const contextRefs: Array<Record<string, unknown>> = []
  const signals: Array<AbortSignal | undefined> = []
  let savedToolState: ThreadState | undefined
  let nestedUsesResults: { allowed: ToolResult; blocked: ToolResult } | undefined

  const tools = {
    unlisted_helper: defineTool({
      description: "Not offered on prompt; inspects env, context, signal, and writes message",
      args: z.object({ source: z.string() }),
      execute: async (state: ThreadState, args: { source: string }) => {
        savedToolState = state
        contextRefs.push(state.context)
        signals.push(state.execution?.abortSignal)
        const agentVal = await state.env("AGENT_ONLY_KEY")
        const promptVal = await state.env("PROMPT_ONLY_KEY").catch(() => "missing")
        const sharedVal = await state.env("SHARED_KEY")
        state.context[`tool_${args.source}`] = true
        seen.push({
          source: args.source,
          flowId: state.execution?.flowId,
          agentVal,
          promptVal,
          sharedVal,
          fromCtx: state.context[`hook_${args.source}`],
        })
        if (args.source === "filter") {
          await state.injectMessage({ role: "system", content: `leaked=${agentVal}:${promptVal}` })
        }
        return ok(`ok:${args.source}:${sharedVal}`)
      },
    }),
    allowed_sub: stubTool("Allowed nested sub-tool", "sub-allowed"),
    forbidden_sub: stubTool("Forbidden nested sub-tool", "sub-forbidden"),
    gatekeeper: defineTool({
      description: "Enforces its own uses list for nested invokeTool",
      uses: ["allowed_sub"] as Array<string>,
      execute: async (state: ThreadState) => {
        const allowed = await state.invokeTool("allowed_sub", {})
        const blocked = await state.invokeTool("forbidden_sub", {})
        nestedUsesResults = { allowed, blocked }
        return ok("checked-uses")
      },
    }),
  }

  const hooks = [
    ...storageHooks(firedStorage),
    defineHook({
      hook: "before_create_message",
      id: "delivery_invoke",
      execute: async (state, message) => {
        if (message.content === "go") {
          contextRefs.push(state.context)
          signals.push(state.execution?.abortSignal)
          state.context.hook_delivery = "set-in-delivery"
          const result = await state.invokeTool("unlisted_helper", { source: "delivery" })
          expect(result).toEqual({ status: "success", result: "ok:delivery:AGENT_SHARED_901" })
          expect(await attempt(() => savedToolState?.setValue("late", "no"))).toBe("HandleExpired")
        }
        return message
      },
    }),
    defineHook({
      hook: "filter_messages",
      id: "prompt_filter_invoke",
      execute: async (state, messages) => {
        contextRefs.push(state.context)
        signals.push(state.execution?.abortSignal)
        state.context.hook_filter = "set-in-filter"
        const res = await state.invokeTool("unlisted_helper", { source: "filter" })
        expect(res).toEqual({ status: "success", result: "ok:filter:AGENT_SHARED_901" })
        expect(state.context.tool_filter).toBe(true)
        const gateRes = await state.invokeTool("gatekeeper", {})
        expect(gateRes).toEqual({ status: "success", result: "checked-uses" })
        return messages
      },
    }),
    defineHook({
      hook: "before_create_message",
      id: "prompt_before_invoke",
      execute: async (state, message) => {
        if (message.role === "assistant" && message.content === "reply") {
          state.context.hook_before = "set-in-before"
          const res = await state.invokeTool("unlisted_helper", { source: "before" })
          expect(res).toEqual({ status: "success", result: "ok:before:AGENT_SHARED_901" })
        }
        return message
      },
    }),
    defineHook({
      hook: "after_create_message",
      id: "prompt_after_invoke",
      execute: async (state, message) => {
        if (message.role === "assistant" && message.content === "reply") {
          state.context.hook_after = "set-in-after"
          const res = await state.invokeTool("unlisted_helper", { source: "after" })
          expect(res).toEqual({ status: "success", result: "ok:after:AGENT_SHARED_901" })
        }
      },
    }),
  ]

  const provider = new ScriptedProvider([{ text: "reply" }])
  await usingDirect(
    driver,
    {
      provider,
      tools,
      hooks,
      agent: {
        hooks: ["delivery_invoke", ...STORAGE_HOOK_IDS],
        env: { AGENT_ONLY_KEY: "AGENT_SECRET_901", SHARED_KEY: "AGENT_SHARED_901" },
      },
      prompt: {
        tools: [],
        hooks: ["prompt_filter_invoke", "prompt_before_invoke", "prompt_after_invoke", ...STORAGE_HOOK_IDS],
        env: { PROMPT_ONLY_KEY: "PROMPT_SECRET_902", SHARED_KEY: "PROMPT_SHARED_902" },
      },
    },
    async (session, thread) => {
      const outcome = await session.send(thread, "go")
      expect(outcome).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      expect(seen).toEqual([
        {
          source: "delivery",
          flowId: expect.any(String),
          agentVal: "AGENT_SECRET_901",
          promptVal: "missing",
          sharedVal: "AGENT_SHARED_901",
          fromCtx: "set-in-delivery",
        },
        {
          source: "filter",
          flowId: seen[0]?.flowId,
          agentVal: "AGENT_SECRET_901",
          promptVal: "PROMPT_SECRET_902",
          sharedVal: "AGENT_SHARED_901",
          fromCtx: "set-in-filter",
        },
        {
          source: "before",
          flowId: seen[0]?.flowId,
          agentVal: "AGENT_SECRET_901",
          promptVal: "PROMPT_SECRET_902",
          sharedVal: "AGENT_SHARED_901",
          fromCtx: "set-in-before",
        },
        {
          source: "after",
          flowId: seen[0]?.flowId,
          agentVal: "AGENT_SECRET_901",
          promptVal: "PROMPT_SECRET_902",
          sharedVal: "AGENT_SHARED_901",
          fromCtx: "set-in-after",
        },
      ])
      expect(contextRefs.every((ref) => ref === contextRefs[0])).toBe(true)
      expect(signals.every((sig) => sig instanceof AbortSignal && sig === signals[0])).toBe(true)
      expect(nestedUsesResults).toEqual({
        allowed: { status: "success", result: "sub-allowed" },
        blocked: { status: "error", error: expect.stringContaining("uses") },
      })
      expect(firedStorage).toEqual([])
      const stored = await session.messages(thread)
      expect(toolResults(stored)).toEqual([])
      expect(stored.some((m) => m.tool_calls !== null)).toBe(false)
      expect(stored.find((m) => m.role === "system")?.content).toBe("leaked=[redacted]:[redacted]")
    },
  )
}

const runHandlerAgentHookInvoke = async (driver: RuntimeDriver) => {
  const firedStorage: Array<string> = []
  let hookFlowId: string | undefined
  let toolSnap: ReturnType<typeof executionSnapshot> = null
  let toolEnv = ""

  const tools = {
    agent_helper: defineTool({
      description: "Invoked from handler-turn agent hook",
      execute: async (state: ThreadState) => {
        toolSnap = executionSnapshot(state)
        toolEnv = await state.env("HANDLER_AGENT_KEY")
        state.context.fromHandlerHookTool = "yes"
        return ok("handler-hook-ok")
      },
    }),
  }
  const hooks = [
    ...storageHooks(firedStorage),
    defineHook({
      hook: "after_create_message",
      id: "handler_after_invoke",
      execute: async (state, message) => {
        if (message.content === "from-handler") {
          hookFlowId = state.execution?.flowId
          const res = await state.invokeTool("agent_helper", {})
          expect(res).toEqual({ status: "success", result: "handler-hook-ok" })
        }
      },
    }),
  ]
  let sawToolContext: unknown
  const relay_handler = handlerOf(async (state) => {
    await state.injectMessage({ role: "assistant", content: "from-handler" })
    sawToolContext = state.context.fromHandlerHookTool
  })

  await usingDirect(
    driver,
    {
      sideA: { handler: "relay_handler" },
      sideB: { human: true },
      handlers: { relay_handler },
      tools,
      hooks,
      agent: {
        hooks: ["handler_after_invoke", ...STORAGE_HOOK_IDS],
        env: { HANDLER_AGENT_KEY: "HANDLER_VAL_903" },
      },
    },
    async (session, thread) => {
      const outcome = await session.send(thread, "ping")
      expect(outcome).toMatchObject({ status: "idle", reason: "handler_idle", steps: 0 })
      expect(toolSnap).toEqual({
        flowId: hookFlowId,
        currentSide: "a",
        promptPath: [],
        stepCount: 0,
        sideAStepCount: 0,
        sideBStepCount: 0,
      })
      expect(toolEnv).toBe("HANDLER_VAL_903")
      expect(sawToolContext).toBe("yes")
      expect(firedStorage).toEqual([])
      const stored = await session.messages(thread)
      expect(toolResults(stored)).toEqual([])
      expect(stored.some((m) => m.tool_calls !== null)).toBe(false)
    },
  )
}

export const DE01: Scenario = {
  name: "DE01 (rules 33, 36-38, 40) invokeTool from prompt, delivery, and handler-turn hooks runs in owning flow with proper env, shared context, target uses, and no synthetic rows",
  requirements: ["39260b1a", "a1ac0a36"],
  run: async (driver) => {
    await runPromptAndDeliveryHookInvoke(driver)
    await runHandlerAgentHookInvoke(driver)
  },
}

export const DE02: Scenario = {
  name: "DE02 (rules 36, 47) packed hook resolves invokeTool in its own package namespace (active and at rest) and cannot see unpacked global tools",
  requirements: ["39260b1a", "a1ac0a36"],
  run: async (driver) => {
    const results: Record<string, ToolResult> = {}
    const provider = new ScriptedProvider([{ text: "packed reply" }])
    const packHook = defineHook({
      hook: "filter_messages",
      id: "pack_filter",
      execute: async (state, messages) => {
        results.inRunPack = await state.invokeTool("shared_name", {})
        results.inRunGlobal = await state.invokeTool("global_only", {})
        return messages
      },
    })
    const packCreated = defineHook({
      hook: "after_thread_created",
      id: "pack_created",
      execute: async (state) => {
        results.atRestPack = await state.invokeTool("shared_name", {})
        results.atRestGlobal = await state.invokeTool("global_only", {})
      },
    })
    const session = await driver.load({
      models: [],
      prompts: [],
      agents: [],
      tools: {
        shared_name: stubTool("Global shared name", "from-global"),
        global_only: stubTool("Only global", "only-global"),
      },
      packages: [
        {
          packageId: "pack_alpha",
          entryAgents: ["entry"],
          models: [defineModel({ name: "pack_model", provider: provider.factory, model: "pack-v1" })],
          prompts: [
            definePrompt({
              name: "pack_prompt",
              toolDescription: "Packed prompt",
              model: "pack_model",
              prompt: "Packed.",
              hooks: ["pack_filter"],
            }),
          ],
          agents: [
            defineAgent({
              name: "entry",
              sideA: { prompt: "pack_prompt" },
              sideB: { human: true },
              hooks: ["pack_created"],
            }),
          ],
          tools: { shared_name: stubTool("Packed shared name", "from-pack-alpha") },
          hooks: [packHook, packCreated],
        },
      ],
    } as Parameters<RuntimeDriver["load"]>[0])
    try {
      const thread = await session.createThread("pack_alpha/entry")
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      expect(results.atRestPack).toEqual({ status: "success", result: "from-pack-alpha" })
      expect(results.atRestGlobal).toMatchObject({ status: "error" })
      expect(results.inRunPack).toEqual({ status: "success", result: "from-pack-alpha" })
      expect(results.inRunGlobal).toMatchObject({ status: "error" })
    } finally {
      await session.close()
    }
  },
}

const runHookValidationAndErrors = async (driver: RuntimeDriver) => {
  let badCalls: Record<string, string> = {}
  let errorShapes: Record<string, ToolResult> = {}
  let stoppedRan = false
  let stoppedResult: ToolResult | undefined
  let expiredResult = ""
  let expiredToolRan = false

  const tools = {
    strict_args: defineTool({
      description: "Requires numeric n",
      args: z.object({ n: z.number() }),
      execute: async (_state, { n }) => ok(String(n)),
    }),
    needs_var: defineTool({
      description: "Requires MISSING_VAR",
      variables: [{ name: "MISSING_VAR", type: "text", required: true, description: "Missing" }],
      execute: async () => ok("unreachable"),
    }),
    throws_err: defineTool({
      description: "Throws error",
      execute: async () => {
        throw new Error("boom in hook tool")
      },
    }),
    bad_return: defineTool({
      description: "Returns invalid ToolResult",
      execute: async () => "not-a-tool-result" as unknown as ToolResult,
    }),
    never_after_stop: defineTool({
      description: "Must not run after stop",
      execute: async () => {
        stoppedRan = true
        return ok("should-not-run")
      },
    }),
    expired_target: defineTool({
      description: "Must not run from expired hook",
      execute: async () => {
        expiredToolRan = true
        return ok("should-not-run")
      },
    }),
  }

  const hooks = [
    defineHook({
      hook: "filter_messages",
      id: "probe_errors",
      execute: async (state, messages) => {
        badCalls = {
          nonStringName: await attempt(() => Reflect.apply(state.invokeTool, state, [123, {}])),
          nonObjectArgs: await attempt(() => Reflect.apply(state.invokeTool, state, ["strict_args", "bad"])),
          nullArgs: await attempt(() => Reflect.apply(state.invokeTool, state, ["strict_args", null])),
        }
        errorShapes = {
          unknown: await state.invokeTool("no_such_tool", {}),
          schema: await state.invokeTool("strict_args", { n: "wrong" }),
          missingVar: await state.invokeTool("needs_var", {}),
          threw: await state.invokeTool("throws_err", {}),
          badReturn: await state.invokeTool("bad_return", {}),
        }
        return messages
      },
    }),
    defineHook({
      hook: "after_create_message",
      id: "stop_then_invoke",
      execute: async (state, message) => {
        if (message.role === "assistant" && message.content === "done") {
          state.execution?.stop()
          stoppedResult = await state.invokeTool("never_after_stop", {})
        }
      },
    }),
  ]

  await usingDirect(
    driver,
    {
      provider: new ScriptedProvider([{ text: "done" }]),
      tools,
      hooks,
      prompt: { hooks: ["probe_errors", "stop_then_invoke"], tools: [] },
    },
    async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "aborted", steps: 1 })
      expect(badCalls).toEqual({
        nonStringName: "InvalidArguments",
        nonObjectArgs: "InvalidArguments",
        nullArgs: "InvalidArguments",
      })
      for (const result of Object.values(errorShapes)) {
        expect(result).toMatchObject({ status: "error", error: expect.any(String) })
      }
      expect(errorShapes.threw?.error).toContain("boom in hook tool")
      expect(errorShapes.badReturn?.error).toContain("not a ToolResult")
      expect(stoppedRan).toBe(false)
      expect(stoppedResult).toMatchObject({
        status: "error",
        error: expect.stringContaining("stopped before the call started"),
      })
      expect(toolResults(await session.messages(thread))).toEqual([])
    },
  )

  // Expired hook handle rejects invokeTool with HookExpired before lookup or execution.
  let lateDone: (() => void) | undefined
  const lateReady = new Promise<void>((resolve) => {
    lateDone = resolve
  })
  const slowHook = defineHook({
    hook: "filter_messages",
    id: "slow_invoke",
    execute: async (state, messages) => {
      await new Promise((resolve) => setTimeout(resolve, 180))
      expiredResult = await attempt(() => state.invokeTool("expired_target", {}))
      lateDone?.()
      return messages
    },
  })
  await usingDirect(
    driver,
    {
      provider: new ScriptedProvider([{ text: "after-timeout" }]),
      tools: { expired_target: tools.expired_target },
      hooks: [slowHook],
      prompt: { hooks: ["slow_invoke"], tools: [] },
    },
    async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 1 })
      await lateReady
      expect(expiredResult).toBe("HookExpired")
      expect(expiredToolRan).toBe(false)
    },
    { hookTimeoutMs: 60 },
  )
}

const runNestedWriteDepthThroughTool = async (driver: RuntimeDriver) => {
  const refusedTags: Array<string> = []
  const tools = {
    bouncer: defineTool({
      description: "Bounce back into injectMessage from a hook",
      args: z.object({ next: z.number() }),
      execute: async (state: ThreadState, { next }: { next: number }) => {
        const outcome = await attempt(() => state.injectMessage({ role: "user", content: `bounce ${next}` }))
        if (outcome !== "done") {
          refusedTags.push(outcome)
          return { status: "error" as const, error: outcome }
        }
        return ok(`bounced ${next}`)
      },
    }),
    kickoff: defineTool({
      description: "Start the bounce chain",
      execute: async (state: ThreadState) => {
        await state.injectMessage({ role: "user", content: "bounce 0" })
        return ok("kicked")
      },
    }),
  }
  const hook = defineHook({
    hook: "before_create_message",
    id: "bounce_hook",
    execute: async (state, message) => {
      const match = message.content?.match(/^bounce (\d+)$/)
      if (match) {
        const depth = Number(match[1])
        if (depth < 12) await state.invokeTool("bouncer", { next: depth + 1 })
      }
      return message
    },
  })
  const provider = new ScriptedProvider([
    { toolCalls: [{ id: "c1", name: "kickoff", arguments: {} }] },
    { text: "finished" },
  ])
  await usingDirect(
    driver,
    { provider, tools, hooks: [hook], prompt: { hooks: ["bounce_hook"], tools: ["kickoff"] } },
    async (session, thread) => {
      expect(await session.send(thread, "go")).toMatchObject({ status: "idle", reason: "stop_on_response", steps: 2 })
      const bounced = (await session.messages(thread))
        .map((m) => m.content)
        .filter((c): c is string => typeof c === "string" && /^bounce [1-9]\d*$/.test(c))
      expect(bounced.sort()).toEqual([
        "bounce 1",
        "bounce 2",
        "bounce 3",
        "bounce 4",
        "bounce 5",
        "bounce 6",
        "bounce 7",
        "bounce 8",
      ])
      expect(refusedTags).toEqual(["NestedWriteTooDeep"])
    },
  )
}

export const DE03: Scenario = {
  name: "DE03 (rules 34, 39, 40) enforces invokeTool validation, HookExpired, NestedWriteTooDeep across hook->tool->injectMessage, error shapes, and notRun on stop",
  requirements: ["39260b1a", "a1ac0a36"],
  run: async (driver) => {
    await runHookValidationAndErrors(driver)
    await runNestedWriteDepthThroughTool(driver)
  },
}
