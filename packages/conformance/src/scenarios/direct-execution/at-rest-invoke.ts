import { defineHook, definePrompt, defineTool, type ThreadState, type ToolResult } from "@standardagents/spec"
import { expect } from "vitest"
import { z } from "zod"
import type { RuntimeDriver, RuntimeSession } from "../../RuntimeDriver.ts"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { executionSnapshot, handlerOf } from "../handlers/fixtures.ts"
import {
  attempt,
  gate,
  ok,
  quiet,
  type Scenario,
  statusOf,
  stubTool,
  toolResults,
  waitForAdmission,
} from "../harness.ts"
import {
  gatedTool,
  promptAgent,
  raceGate,
  STORAGE_HOOK_IDS,
  storageHooks,
  usingDirect,
  usingDirectPeer,
} from "./fixtures.ts"

const verifyMinimalExecutionForSide = async (
  driver: RuntimeDriver,
  config: { readonly label: string; readonly humanOn: "a" | "b"; readonly expectedSide: "a" | "b" },
) => {
  const firedStorage: Array<string> = []
  const hookEvents: Array<string> = []
  let observedRunning: unknown
  let snap: ReturnType<typeof executionSnapshot> = null
  let liveHistoryAfterInject: Array<string | null> = []
  let nestedUses: { ok: ToolResult; blocked: ToolResult } | undefined
  let envRead: { agent: string; prompt: string } | undefined
  const ctxBetweenRuns: Array<unknown> = []
  let peerRef: RuntimeSession | undefined
  let threadRef = ""

  const tools = {
    allowed_child: stubTool("Allowed nested child", "child-ok"),
    blocked_child: stubTool("Blocked nested child", "child-blocked"),
    direct_probe: defineTool({
      description: "Inspect minimal ExecutionState at rest",
      uses: ["allowed_child"] as Array<string>,
      execute: async (state: ThreadState) => {
        ctxBetweenRuns.push(state.context.marker)
        state.context.marker = "transient"
        snap = executionSnapshot(state)
        expect(state.execution?.abortSignal instanceof AbortSignal).toBe(true)
        expect(state.execution?.abortSignal.aborted).toBe(false)
        // Rule 46: forceTurn inside a minimal tool execution is a no-op.
        state.execution?.forceTurn(config.expectedSide === "a" ? "b" : "a")
        observedRunning = peerRef ? await peerRef.inspect(threadRef) : undefined
        envRead = {
          agent: await state.env("AGENT_DIRECT_KEY"),
          prompt: await state.env("PROMPT_ONLY_DIRECT").catch(() => "missing"),
        }
        await state.setValue("direct_kv", config.label)
        await state.injectMessage({ role: "system", content: `direct-note:${envRead.agent}` })
        liveHistoryAfterInject = (state.execution?.messageHistory ?? []).map((m) => m.content)
        nestedUses = {
          ok: await state.invokeTool("allowed_child", {}),
          blocked: await state.invokeTool("blocked_child", {}),
        }
        return ok(`done:${config.label}`)
      },
    }),
    soft_error: defineTool({
      description: "Returns ToolResult error",
      execute: async () => ({ status: "error" as const, error: "soft-err" }),
    }),
    throws_direct: defineTool({
      description: "Throws error",
      execute: async () => {
        throw new Error("direct-boom")
      },
    }),
    bad_shape: defineTool({
      description: "Bad shape",
      execute: async () => 42 as unknown as ToolResult,
    }),
    stop_inside: defineTool({
      description: "Calls execution.stop() then invokes a nested tool",
      execute: async (state: ThreadState) => {
        state.execution?.stop()
        const skipped = await state.invokeTool("allowed_child", {})
        return ok(`skipped:${skipped.status}:${skipped.error ?? ""}`)
      },
    }),
  }

  const hooks = [
    ...storageHooks(firedStorage),
    defineHook({
      hook: "before_create_message",
      id: "de_before",
      execute: async (_state, message) => {
        hookEvents.push(`before:${message.role}`)
        return message
      },
    }),
  ]
  const provider = new ScriptedProvider([{ text: "prompt reply" }])
  const human = { human: true } as const
  const promptSide = { prompt: "assistant" } as const

  await usingDirectPeer(
    driver,
    {
      provider,
      sideA: config.humanOn === "a" ? human : promptSide,
      sideB: config.humanOn === "b" ? human : promptSide,
      tools,
      hooks,
      agent: {
        hooks: ["de_before", ...STORAGE_HOOK_IDS],
        env: { AGENT_DIRECT_KEY: "DIRECT_AGENT_SECRET_77" },
        maxSessionTurns: 1,
      },
      prompt: { env: { PROMPT_ONLY_DIRECT: "DIRECT_PROMPT_SECRET_88" }, tools: [] },
    },
    async (session, thread, peer) => {
      peerRef = peer
      threadRef = thread
      await session.seed(thread, [{ role: "user", content: "seeded-prior" }])
      const rest = await session.state(thread)
      expect(await attempt(() => Reflect.apply(rest.invokeTool, rest, [99, {}]))).toBe("InvalidArguments")
      expect(await attempt(() => Reflect.apply(rest.invokeTool, rest, ["direct_probe", "nope"]))).toBe(
        "InvalidArguments",
      )

      const res1 = await rest.invokeTool("direct_probe", {})
      expect(res1).toEqual({ status: "success", result: `done:${config.label}` })
      expect(snap).toEqual({
        flowId: expect.any(String),
        currentSide: config.expectedSide,
        promptPath: [],
        stepCount: 0,
        sideAStepCount: 0,
        sideBStepCount: 0,
      })
      expect(observedRunning).toMatchObject({
        status: { state: "running", reason: null },
        claim: { flowId: snap?.flowId, pid: expect.any(Number) },
      })
      expect(envRead).toEqual({ agent: "DIRECT_AGENT_SECRET_77", prompt: "missing" })
      expect(liveHistoryAfterInject).toEqual(["seeded-prior", "direct-note:[redacted]"])
      expect(nestedUses).toEqual({
        ok: { status: "success", result: "child-ok" },
        blocked: { status: "error", error: expect.stringContaining("uses") },
      })
      expect(await peer.inspect(thread)).toMatchObject({
        status: { state: "idle", reason: "direct_tool" },
        claim: null,
        values: { direct_kv: config.label },
      })
      expect(hookEvents).toEqual(["before:system"])
      expect(firedStorage).toEqual([])
      expect(toolResults(await session.messages(thread))).toEqual([])
      expect((await session.messages(thread)).some((m) => m.tool_calls !== null)).toBe(false)

      // Second direct call gets fresh context; error/throw/bad-shape still settle idle (direct_tool).
      expect(await rest.invokeTool("direct_probe", {})).toMatchObject({ status: "success" })
      expect(ctxBetweenRuns).toEqual([undefined, undefined])
      expect(await rest.invokeTool("soft_error", {})).toEqual({ status: "error", error: "soft-err" })
      expect(await statusOf(peer, thread)).toMatchObject({ state: "idle", reason: "direct_tool" })
      expect(await rest.invokeTool("throws_direct", {})).toMatchObject({
        status: "error",
        error: expect.stringContaining("direct-boom"),
      })
      expect(await statusOf(peer, thread)).toMatchObject({ state: "idle", reason: "direct_tool" })
      expect(await rest.invokeTool("bad_shape", {})).toMatchObject({
        status: "error",
        error: expect.stringContaining("not a ToolResult"),
      })
      expect(await statusOf(peer, thread)).toMatchObject({ state: "idle", reason: "direct_tool" })

      const stopRes = await rest.invokeTool("stop_inside", {})
      expect(stopRes).toMatchObject({
        status: "success",
        result: expect.stringContaining("skipped:error:"),
      })

      // Rule 47: direct invokeTool does not increment threads.session_turns, so maxSessionTurns: 1 still runs 1 turn.
      expect(await session.send(thread, "hello")).toMatchObject({
        status: "idle",
        reason: "max_session_turns",
        steps: 1,
      })
    },
  )
}

export const DE04: Scenario = {
  name: "DE04 (rules 41, 45-49) direct at-rest invokeTool claims running, exposes minimal ExecutionState, settles idle (direct_tool), survives control poll, and preserves session_turns",
  requirements: ["39260b1a", "a1ac0a36"],
  run: async (driver) => {
    await verifyMinimalExecutionForSide(driver, { label: "side-a-prompt", humanOn: "b", expectedSide: "a" })
    await verifyMinimalExecutionForSide(driver, { label: "side-b-prompt", humanOn: "a", expectedSide: "b" })

    // Also verify survival past the 250ms control poll tick on a handler x human thread.
    const slow_direct = defineTool({
      description: "Sleeps across control poll interval",
      execute: async (state: ThreadState) => {
        expect(state.execution?.currentSide).toBe("a")
        await new Promise((resolve) => setTimeout(resolve, 350))
        await state.setValue("after_poll", true)
        return ok("survived-poll")
      },
    })
    const noop_handler = handlerOf(async () => {})
    await usingDirectPeer(
      driver,
      {
        sideA: { handler: "noop_handler" },
        sideB: { human: true },
        handlers: { noop_handler },
        tools: { slow_direct },
      },
      async (session, thread, peer) => {
        const rest = await session.state(thread)
        expect(await rest.invokeTool("slow_direct", {})).toEqual({ status: "success", result: "survived-poll" })
        expect(await peer.inspect(thread)).toMatchObject({
          status: { state: "idle", reason: "direct_tool" },
          claim: null,
          values: { after_poll: true },
        })
      },
    )
  },
}

export const DE05: Scenario = {
  name: "DE05 (rules 41, 46-49) invokeTool works from after_thread_created and at-rest before_create_message hooks, inherits depth for NestedWriteTooDeep, and checks HookExpired",
  requirements: ["39260b1a", "a1ac0a36"],
  run: async (driver) => {
    let createdSnap: ReturnType<typeof executionSnapshot> = null
    const refusedDepth: Array<string> = []
    const tools = {
      init_tool: defineTool({
        description: "Runs during after_thread_created",
        execute: async (state: ThreadState) => {
          createdSnap = executionSnapshot(state)
          await state.setValue("bootstrapped", true)
          await state.injectMessage({ role: "system", content: "bootstrapped-note" })
          return ok("init-ok")
        },
      }),
      enrich: defineTool({
        description: "Runs during at-rest before_create_message",
        execute: async (state: ThreadState) => {
          await state.setValue("enriched", true)
          return ok("stamped-at-rest")
        },
      }),
      at_rest_bouncer: defineTool({
        description: "Bounces back into injectMessage from at-rest before_create_message",
        args: z.object({ next: z.number() }),
        execute: async (state: ThreadState, { next }: { next: number }) => {
          const outcome = await attempt(() => state.injectMessage({ role: "user", content: `rest-bounce ${next}` }))
          if (outcome !== "done") {
            refusedDepth.push(outcome)
            return { status: "error" as const, error: outcome }
          }
          return ok(`rest-bounced ${next}`)
        },
      }),
    }
    const hooks = [
      defineHook({
        hook: "after_thread_created",
        id: "on_create_invoke",
        execute: async (state) => {
          expect(state.execution).toBeNull()
          const res = await state.invokeTool("init_tool", {})
          expect(res).toEqual({ status: "success", result: "init-ok" })
        },
      }),
      defineHook({
        hook: "before_create_message",
        id: "on_rest_create_invoke",
        execute: async (state, message) => {
          if (message.content === "enrich-me") {
            expect(state.execution).toBeNull()
            const res = await state.invokeTool("enrich", {})
            expect(res).toEqual({ status: "success", result: "stamped-at-rest" })
            return { ...message, metadata: { ...message.metadata, tag: res.status === "success" ? res.result : "" } }
          }
          const match = message.content?.match(/^rest-bounce (\d+)$/)
          if (match) {
            const depth = Number(match[1])
            if (depth < 12) await state.invokeTool("at_rest_bouncer", { next: depth + 1 })
          }
          return message
        },
      }),
    ]
    await usingDirectPeer(
      driver,
      {
        provider: new ScriptedProvider([]),
        tools,
        hooks,
        agent: { hooks: ["on_create_invoke", "on_rest_create_invoke"] },
      },
      async (session, thread, peer) => {
        expect(createdSnap).toEqual({
          flowId: expect.any(String),
          currentSide: "a",
          promptPath: [],
          stepCount: 0,
          sideAStepCount: 0,
          sideBStepCount: 0,
        })
        expect(await peer.inspect(thread)).toMatchObject({
          status: { state: "idle", reason: "direct_tool" },
          values: { bootstrapped: true },
        })

        const rest = await session.state(thread)
        const enriched = await rest.injectMessage({ role: "user", content: "enrich-me" })
        expect(enriched.metadata).toMatchObject({ tag: "stamped-at-rest" })
        expect(await peer.inspect(thread)).toMatchObject({
          status: { state: "idle", reason: "direct_tool" },
          values: { bootstrapped: true, enriched: true },
        })

        await rest.injectMessage({ role: "user", content: "rest-bounce 0" })
        const bounced = (await session.messages(thread))
          .map((m) => m.content)
          .filter((c): c is string => typeof c === "string" && /^rest-bounce [1-9]\d*$/.test(c))
        expect(bounced.sort()).toEqual([
          "rest-bounce 1",
          "rest-bounce 2",
          "rest-bounce 3",
          "rest-bounce 4",
          "rest-bounce 5",
          "rest-bounce 6",
          "rest-bounce 7",
          "rest-bounce 8",
        ])
        expect(refusedDepth).toEqual(["NestedWriteTooDeep"])
        expect(toolResults(await session.messages(thread))).toEqual([])
      },
    )

    // Expired at-rest hook handle rejects invokeTool with HookExpired.
    let expiredOutcome = ""
    let expiredRan = false
    const lateDone = gate()
    const slowCreated = defineHook({
      hook: "after_thread_created",
      id: "slow_created_invoke",
      execute: async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 180))
        expiredOutcome = await attempt(() => state.invokeTool("never_runs", {}))
        lateDone.release()
      },
    })
    const never_runs = defineTool({
      description: "Must not run",
      execute: async () => {
        expiredRan = true
        return ok("no")
      },
    })
    await usingDirect(
      driver,
      {
        provider: new ScriptedProvider([]),
        tools: { never_runs },
        hooks: [slowCreated],
        agent: { hooks: ["slow_created_invoke"] },
      },
      async () => {
        await lateDone.opened
        expect(expiredOutcome).toBe("HookExpired")
        expect(expiredRan).toBe(false)
      },
      { hookTimeoutMs: 60 },
    )
  },
}

const expectThreadBusy = async (call: () => Promise<unknown>, threadId: string) => {
  try {
    await call()
    throw new Error("expected ThreadBusy rejection")
  } catch (error) {
    expect(error).toMatchObject({ _tag: "ThreadBusy" })
    expect(error instanceof Error ? error.message : String(error)).toContain(threadId)
  }
}

export const DE06: Scenario = {
  name: "DE06 (rules 42-44) at-rest invokeTool rejects with ThreadBusy on concurrent or agent-held threads, rejects with ThreadTerminated on old/new handles, and claims from failed",
  requirements: ["9090af10", "dc7d7df0"],
  run: async (driver) => {
    const entered = gate()
    const release = gate()
    let ranForbidden = 0
    const tools = {
      hold: gatedTool(entered, release),
      quick: stubTool("Quick", "quick-ok"),
      forbidden: defineTool({
        description: "Must not run when rejected",
        execute: async () => {
          ranForbidden += 1
          return ok("ran")
        },
      }),
    }
    const provider = new ScriptedProvider([
      { toolCalls: [{ id: "c1", name: "hold", arguments: {} }] },
      { text: "agent done" },
    ])

    await usingDirectPeer(driver, { provider, tools }, async (session, thread, peer) => {
      const rest = await session.state(thread)
      const peerRest = await peer.state(thread)

      // Part 1: Concurrent at-rest invokeTool -> ThreadBusy (both same session and peer).
      const firstDirect = quiet(rest.invokeTool("hold", {}))
      try {
        await raceGate(entered.opened, firstDirect, "first direct invokeTool")
        await expectThreadBusy(() => rest.invokeTool("forbidden", {}), thread)
        await expectThreadBusy(() => peerRest.invokeTool("forbidden", {}), thread)
      } finally {
        release.release()
      }
      expect(await firstDirect).toEqual({ status: "success", result: "released" })
      expect(await rest.invokeTool("quick", {})).toEqual({ status: "success", result: "quick-ok" })

      // Part 2: Agent prompt run holds the thread -> ThreadBusy.
      const enteredRun = gate()
      const releaseRun = gate()
      const runTools = { hold_run: gatedTool(enteredRun, releaseRun), forbidden: tools.forbidden }
      await usingDirectPeer(
        driver,
        {
          provider: new ScriptedProvider([
            { toolCalls: [{ id: "c_run", name: "hold_run", arguments: {} }] },
            { text: "done" },
          ]),
          tools: runTools,
        },
        async (runSession, runThread, runPeer) => {
          const running = quiet(runSession.send(runThread, "go"))
          try {
            await raceGate(enteredRun.opened, running, "agent run tool")
            const sRest = await runSession.state(runThread)
            const pRest = await runPeer.state(runThread)
            await expectThreadBusy(() => sRest.invokeTool("forbidden", {}), runThread)
            await expectThreadBusy(() => pRest.invokeTool("forbidden", {}), runThread)
          } finally {
            releaseRun.release()
          }
          expect(await running).toMatchObject({ status: "idle", reason: "stop_on_response" })
        },
      )

      // Part 3: Claim from failed (after forced recovery -> execution_lost).
      const lostEntered = gate()
      const lostRelease = gate()
      const lostTools = { hold_lost: gatedTool(lostEntered, lostRelease), quick: tools.quick }
      await usingDirectPeer(
        driver,
        {
          provider: new ScriptedProvider([{ toolCalls: [{ id: "c_lost", name: "hold_lost", arguments: {} }] }]),
          tools: lostTools,
        },
        async (lostSession, lostThread, lostPeer) => {
          const run = quiet(lostSession.send(lostThread, "go")).catch(() => undefined)
          try {
            await raceGate(lostEntered.opened, run, "lost tool")
            await lostPeer.forceRecover(lostThread)
          } finally {
            lostRelease.release()
          }
          await run
          expect(await statusOf(lostPeer, lostThread)).toMatchObject({ state: "failed", reason: "execution_lost" })
          const afterLost = await lostPeer.state(lostThread)
          expect(await afterLost.invokeTool("quick", {})).toEqual({ status: "success", result: "quick-ok" })
          expect(await statusOf(lostPeer, lostThread)).toMatchObject({ state: "idle", reason: "direct_tool" })
        },
      )

      // Part 4 (rule 43): Terminated thread rejects handles created before and after termination.
      const beforeTerm = await session.state(thread)
      await peerRest.terminate()
      const afterTerm = await peer.state(thread)
      const snapshot = await peer.inspect(thread)
      expect(await attempt(() => beforeTerm.invokeTool("forbidden", {}))).toBe("ThreadTerminated")
      expect(await attempt(() => afterTerm.invokeTool("forbidden", {}))).toBe("ThreadTerminated")
      expect(await peer.inspect(thread)).toEqual(snapshot)
      expect(ranForbidden).toBe(0)
    })
  },
}

const runWatermarkParkedOnly = async (driver: RuntimeDriver) => {
  const entered = gate()
  const release = gate()
  const tools = {
    hold: gatedTool(entered, release),
    quick: stubTool("Quick at rest", "quick-done"),
  }
  const provider = new ScriptedProvider([
    { toolCalls: [{ id: "c1", name: "hold", arguments: {} }] },
    { text: "turn 1 done" },
  ])
  await usingDirectPeer(driver, { provider, tools, agent: { maxSessionTurns: 1 } }, async (session, thread, peer) => {
    const first = quiet(session.send(thread, "go"))
    try {
      await raceGate(entered.opened, first, "turn 1 tool")
      // Queue work while turn 1 runs; maxSessionTurns: 1 sets continueIfQueued: false, parking it in the queue.
      await (await peer.state(thread)).queueMessage({ role: "user", content: "parked-before-direct" })
    } finally {
      release.release()
    }
    expect(await first).toMatchObject({ status: "idle", reason: "max_session_turns" })
    expect((await peer.inspect(thread)).queue).toHaveLength(1)

    // Direct invokeTool at rest must leave pre-existing parked work (seq <= watermark) untouched.
    const rest = await session.state(thread)
    expect(await rest.invokeTool("quick", {})).toEqual({ status: "success", result: "quick-done" })
    await new Promise((resolve) => setTimeout(resolve, 60))
    const after = await peer.inspect(thread)
    expect(after.status).toMatchObject({ state: "idle", reason: "direct_tool" })
    expect(after.queue).toHaveLength(1)
    expect(provider.requests).toHaveLength(2)
  })
}

const runWatermarkAdmittedDuring = async (driver: RuntimeDriver, kind: "queueMessage" | "queueTool" | "runAgent") => {
  const enteredTool = gate()
  const releaseTool = gate()
  const enteredFollowUp = gate()
  const releaseFollowUp = gate()
  const helperProvider = new ScriptedProvider([
    async () => {
      enteredFollowUp.release()
      await releaseFollowUp.opened
      return { text: "helper-wakeup-reply" }
    },
  ])
  const mainProvider = new ScriptedProvider([
    async () => {
      enteredFollowUp.release()
      await releaseFollowUp.opened
      return { text: `wakeup-${kind}` }
    },
  ])
  const helper = promptAgent("helper_agent", helperProvider)
  const tools = {
    hold: gatedTool(enteredTool, releaseTool),
    echo: stubTool("Echo", "queued-during-direct"),
  }
  await usingDirectPeer(
    driver,
    {
      provider: mainProvider,
      tools,
      models: [helper.model],
      prompts: [
        definePrompt({
          name: "assistant",
          toolDescription: "Main",
          model: "scripted",
          prompt: "Main.",
          tools: ["hold", "echo"],
        }),
        helper.prompt,
      ],
      agents: [helper.agent],
    },
    async (session, thread, peer) => {
      const rest = await session.state(thread)
      const direct = quiet(rest.invokeTool("hold", {}))
      try {
        await raceGate(enteredTool.opened, direct, `direct tool for ${kind}`)
        const peerRest = await peer.state(thread)
        if (kind === "queueMessage") await peerRest.queueMessage({ role: "user", content: "admitted-during" })
        else if (kind === "queueTool") peerRest.queueTool("echo", {})
        else await peerRest.runAgent("helper_agent")
      } finally {
        releaseTool.release()
      }
      // invokeTool resolves immediately upon minimal settlement without waiting for the follow-up run.
      expect(await direct).toEqual({ status: "success", result: "released" })
      try {
        await enteredFollowUp.opened
      } finally {
        releaseFollowUp.release()
      }
      await waitForAdmission(async () => {
        const stored = await peer.inspect(thread)
        return (
          stored.status.state === "idle" && stored.queue.length === 0 && stored.status.reason === "stop_on_response"
        )
      })
      const contents = (await session.messages(thread)).map((m) => m.content)
      expect(contents.at(-1)).toBe(kind === "runAgent" ? "helper-wakeup-reply" : `wakeup-${kind}`)
    },
  )
}

export const DE07: Scenario = {
  name: "DE07 (rule 50) watermark wakeup leaves pre-existing parked work untouched and triggers follow-up run for queueMessage, queueTool, or runAgent admitted during invokeTool",
  requirements: ["39260b1a", "a1ac0a36"],
  run: async (driver) => {
    await runWatermarkParkedOnly(driver)
    await runWatermarkAdmittedDuring(driver, "queueMessage")
    await runWatermarkAdmittedDuring(driver, "queueTool")
    await runWatermarkAdmittedDuring(driver, "runAgent")
  },
}
