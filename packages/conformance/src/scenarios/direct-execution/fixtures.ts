import {
  type AgentDefinition,
  defineAgent,
  defineHook,
  defineModel,
  definePrompt,
  defineTool,
  type HandlerDefinition,
  type ModelDefinition,
  type PromptDefinition,
  type ThreadState,
} from "@standardagents/spec"
import type { LoadOptions, Project, RuntimeDriver, RuntimeSession } from "../../RuntimeDriver.ts"
import type { ScriptedProvider } from "../../ScriptedProvider.ts"
import { type HandlerProject, type HandlerSetup, handlerProject } from "../handlers/fixtures.ts"
import { ok, quiet } from "../harness.ts"

export interface PackedProject {
  readonly packageId: string
  readonly entryAgents?: ReadonlyArray<string>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly prompts?: ReadonlyArray<PromptDefinition>
  readonly models?: ReadonlyArray<ModelDefinition>
  readonly tools?: Project["tools"]
  readonly hooks?: Project["hooks"]
  readonly handlers?: Readonly<Record<string, HandlerDefinition>>
}

export interface DirectProject extends HandlerProject {
  readonly packages?: ReadonlyArray<PackedProject>
}

export interface DirectSetup extends Omit<HandlerSetup, "sideA" | "sideB"> {
  readonly sideA?: HandlerSetup["sideA"]
  readonly sideB?: HandlerSetup["sideB"]
  readonly prompt?: Partial<PromptDefinition>
  readonly models?: ReadonlyArray<ModelDefinition>
  readonly packages?: ReadonlyArray<PackedProject>
  readonly agentName?: string
}

export const directProject = (setup: DirectSetup): DirectProject => {
  const hasPrompt = setup.provider !== undefined && setup.prompts === undefined
  const defaultPrompts = hasPrompt
    ? [
        definePrompt({
          name: "assistant",
          toolDescription: "Answers questions",
          model: "scripted",
          prompt: "You are a test assistant.",
          tools: Object.keys(setup.tools ?? {}),
          ...setup.prompt,
        } as PromptDefinition),
      ]
    : setup.prompts
  const base = handlerProject({
    ...setup,
    sideA: setup.sideA ?? { prompt: setup.prompt?.name ?? "assistant" },
    sideB: setup.sideB ?? { human: true },
    ...(defaultPrompts === undefined ? {} : { prompts: defaultPrompts }),
    agent: { name: setup.agentName ?? "assistant", ...setup.agent },
  })
  return {
    ...base,
    models: [...base.models, ...(setup.models ?? [])],
    ...(setup.packages === undefined ? {} : { packages: setup.packages }),
  }
}

export const usingDirect = async <A>(
  driver: RuntimeDriver,
  setup: DirectSetup,
  body: (session: RuntimeSession, thread: string) => Promise<A>,
  options?: LoadOptions,
): Promise<A> => {
  const session = await driver.load(directProject(setup), options)
  try {
    return await body(session, await session.createThread(setup.agent?.name ?? setup.agentName ?? "assistant"))
  } finally {
    await session.close()
  }
}

export const usingDirectPeer = async (
  driver: RuntimeDriver,
  setup: DirectSetup,
  body: (session: RuntimeSession, thread: string, peer: RuntimeSession) => Promise<void>,
  options: LoadOptions = {},
) => {
  const session = await driver.load(directProject(setup), options)
  const peer = await session.peer()
  try {
    await body(session, await session.createThread(setup.agent?.name ?? setup.agentName ?? "assistant"), peer)
  } finally {
    await peer.close()
    await session.close()
  }
}

// Fail fast if a background call settles or rejects before reaching an expected gate.
export const raceGate = async (opened: Promise<void>, pending: Promise<unknown>, label: string) => {
  await Promise.race([
    opened,
    quiet(
      pending.then(
        (value) => {
          throw new Error(`call settled before ${label}: ${JSON.stringify(value)}`)
        },
        (error: unknown) => {
          throw new Error(`call rejected before ${label}: ${error instanceof Error ? error.message : String(error)}`)
        },
      ),
    ),
  ])
}

export const storageHooks = (fired: Array<string>) => [
  defineHook({
    hook: "tool_call_started",
    id: "de_t_started",
    execute: async () => {
      fired.push("tool_call_started")
    },
  }),
  defineHook({
    hook: "after_tool_call_success",
    id: "de_t_success",
    execute: async (_state, _call, result) => {
      fired.push("after_tool_call_success")
      return result
    },
  }),
  defineHook({
    hook: "after_tool_call_failure",
    id: "de_t_failure",
    execute: async (_state, _call, result) => {
      fired.push("after_tool_call_failure")
      return result
    },
  }),
  defineHook({
    hook: "before_store_tool_result",
    id: "de_t_before_store",
    execute: async (_state, _call, result) => {
      fired.push("before_store_tool_result")
      return result
    },
  }),
  defineHook({
    hook: "tool_call_done",
    id: "de_t_done",
    execute: async () => {
      fired.push("tool_call_done")
    },
  }),
]

export const STORAGE_HOOK_IDS = [
  "de_t_started",
  "de_t_success",
  "de_t_failure",
  "de_t_before_store",
  "de_t_done",
] as const

export const promptAgent = (
  name: string,
  provider: ScriptedProvider,
  options: { readonly includeChat?: boolean; readonly side?: "a" | "b"; readonly tools?: Array<string> } = {},
) => {
  const modelName = `${name}_model`
  const promptName = `${name}_prompt`
  const side = options.side ?? "a"
  const promptSide = { prompt: promptName } as const
  const humanSide = { human: true } as const
  return {
    model: defineModel({ name: modelName, provider: provider.factory, model: `scripted-${name}` }),
    prompt: definePrompt({
      name: promptName,
      toolDescription: `Prompt for ${name}`,
      model: modelName,
      prompt: `You are ${name}.`,
      includeChat: options.includeChat ?? true,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }),
    agent: defineAgent({
      name,
      sideA: side === "a" ? promptSide : humanSide,
      sideB: side === "b" ? promptSide : humanSide,
    }),
  }
}

export const gatedTool = (
  entered: { release: () => void },
  release: { opened: Promise<void> },
  onEnter?: (state: ThreadState) => Promise<void> | void,
) =>
  defineTool({
    description: "Wait until released",
    execute: async (state: ThreadState) => {
      await onEnter?.(state)
      entered.release()
      await release.opened
      return ok("released")
    },
  })
