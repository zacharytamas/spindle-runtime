import {
  type AgentDefinition,
  defineAgent,
  defineModel,
  definePrompt,
  defineTool,
  type PromptDefinition,
  type PromptSide,
  type ThreadState,
} from "@standardagents/spec"
import type { LoadOptions, Project, RuntimeDriver, RuntimeSession } from "../../RuntimeDriver.ts"
import type { ScriptedProvider } from "../../ScriptedProvider.ts"
import { ok } from "../harness.ts"

export interface DualSetup {
  readonly providerA: ScriptedProvider
  readonly providerB: ScriptedProvider
  readonly promptA?: Partial<PromptDefinition>
  readonly promptB?: Partial<PromptDefinition>
  readonly sideA?: Partial<PromptSide>
  readonly sideB?: Partial<PromptSide>
  readonly agent?: Partial<AgentDefinition>
  readonly tools?: Project["tools"]
  readonly hooks?: Project["hooks"]
}

export const dualProject = (setup: DualSetup): Project => ({
  models: [
    defineModel({ name: "model_a", provider: setup.providerA.factory, model: "scripted-a" }),
    defineModel({ name: "model_b", provider: setup.providerB.factory, model: "scripted-b" }),
  ],
  prompts: [
    definePrompt({
      name: "worker",
      toolDescription: "Side A worker",
      model: "model_a",
      prompt: "You are side A.",
      tools: Object.keys(setup.tools ?? {}),
      ...setup.promptA,
    } as PromptDefinition),
    definePrompt({
      name: "reviewer",
      toolDescription: "Side B reviewer",
      model: "model_b",
      prompt: "You are side B.",
      tools: Object.keys(setup.tools ?? {}),
      ...setup.promptB,
    } as PromptDefinition),
  ],
  agents: [
    defineAgent({
      name: "pair",
      sideA: { prompt: "worker", ...setup.sideA },
      sideB: { prompt: "reviewer", ...setup.sideB },
      ...setup.agent,
    } as AgentDefinition),
  ],
  tools: setup.tools ?? {},
  ...(setup.hooks === undefined ? {} : { hooks: setup.hooks }),
})

export const usingDual = async <A>(
  driver: RuntimeDriver,
  setup: DualSetup,
  body: (session: RuntimeSession, thread: string) => Promise<A>,
  options?: LoadOptions,
): Promise<A> => {
  const session = await driver.load(dualProject(setup), options)
  try {
    return await body(session, await session.createThread("pair"))
  } finally {
    await session.close()
  }
}

export const usingDualPeer = async (
  driver: RuntimeDriver,
  setup: DualSetup,
  body: (session: RuntimeSession, thread: string, peer: RuntimeSession) => Promise<void>,
  options: LoadOptions = {},
) => {
  const session = await driver.load(dualProject(setup), options)
  const peer = await session.peer()
  try {
    await body(session, await session.createThread("pair"), peer)
  } finally {
    await peer.close()
    await session.close()
  }
}

export const probeTool = (probes: Array<unknown>, result: () => string) =>
  defineTool({
    description: "Record execution state counters",
    execute: async (state: ThreadState) => {
      const e = state.execution
      probes.push([e?.flowId, e?.currentSide, e?.promptPath, e?.stepCount, e?.sideAStepCount, e?.sideBStepCount])
      return ok(result())
    },
  })

export const forceTool = (target: "a" | "b", onRun?: (state: ThreadState) => void) =>
  defineTool({
    description: `Force turn to side ${target}`,
    execute: async (state: ThreadState) => {
      state.execution?.forceTurn(target)
      onRun?.(state)
      return ok(`forced ${target}`)
    },
  })
