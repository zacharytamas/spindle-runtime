import {
  type AgentDefinition,
  defineAgent,
  defineHandler,
  defineModel,
  definePrompt,
  type HandlerDefinition,
  type Message,
  type PromptDefinition,
  type SideConfig,
  type ThreadState,
} from "@standardagents/spec"
import type {
  LoadOptions,
  Project,
  RunOutcome,
  RuntimeDriver,
  RuntimeSession,
  SendOptions,
} from "../../RuntimeDriver.ts"
import type { ScriptedProvider } from "../../ScriptedProvider.ts"

export interface HandlerCall {
  readonly side: "a" | "b"
  readonly handler: string
  readonly messageId: string
  readonly status: "success" | "failed"
  readonly error?: {
    readonly message: string
    readonly origin: string
  }
}

export interface HandlerProject extends Project {
  readonly handlers?: Readonly<Record<string, HandlerDefinition>>
}

export interface HandlerSendOptions extends SendOptions {
  readonly turnCap?: number
}

export interface HandlerRunOutcome extends RunOutcome {
  readonly handlerCalls?: ReadonlyArray<HandlerCall>
}

export interface HandlerSetup {
  readonly sideA: SideConfig
  readonly sideB: SideConfig
  readonly handlers?: Readonly<Record<string, HandlerDefinition>>
  readonly provider?: ScriptedProvider
  readonly providers?: Readonly<Record<string, ScriptedProvider>>
  readonly prompts?: ReadonlyArray<PromptDefinition>
  readonly agent?: Partial<AgentDefinition>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly tools?: Project["tools"]
  readonly hooks?: Project["hooks"]
}

export const handlerProject = (setup: HandlerSetup): HandlerProject => {
  const models = [
    ...(setup.provider === undefined
      ? []
      : [defineModel({ name: "scripted", provider: setup.provider.factory, model: "scripted-model-v1" })]),
    ...Object.entries(setup.providers ?? {}).map(([name, provider]) =>
      defineModel({ name, provider: provider.factory, model: `scripted-${name}` }),
    ),
  ]
  const prompts =
    setup.prompts !== undefined
      ? [...setup.prompts]
      : setup.provider === undefined
        ? []
        : [
            definePrompt({
              name: "assistant",
              toolDescription: "Answers questions",
              model: "scripted",
              prompt: "You are a test assistant.",
              tools: Object.keys(setup.tools ?? {}),
            } as PromptDefinition),
          ]
  return {
    models,
    prompts,
    agents: [
      defineAgent({
        name: "relay",
        sideA: setup.sideA,
        sideB: setup.sideB,
        ...setup.agent,
      } as AgentDefinition),
      ...(setup.agents ?? []),
    ],
    tools: setup.tools ?? {},
    ...(setup.hooks === undefined ? {} : { hooks: setup.hooks }),
    ...(setup.handlers === undefined ? {} : { handlers: setup.handlers }),
  }
}

export const usingHandler = async <A>(
  driver: RuntimeDriver,
  setup: HandlerSetup,
  body: (session: RuntimeSession, thread: string) => Promise<A>,
  options?: LoadOptions,
): Promise<A> => {
  const session = await driver.load(handlerProject(setup), options)
  try {
    return await body(session, await session.createThread(setup.agent?.name ?? "relay"))
  } finally {
    await session.close()
  }
}

export const usingHandlerPeer = async (
  driver: RuntimeDriver,
  setup: HandlerSetup,
  body: (session: RuntimeSession, thread: string, peer: RuntimeSession) => Promise<void>,
  options: LoadOptions = {},
) => {
  const session = await driver.load(handlerProject(setup), options)
  const peer = await session.peer()
  try {
    await body(session, await session.createThread(setup.agent?.name ?? "relay"), peer)
  } finally {
    await peer.close()
    await session.close()
  }
}

export const sendWith = (
  session: RuntimeSession,
  thread: string,
  content: string,
  options?: HandlerSendOptions,
): Promise<HandlerRunOutcome> => session.send(thread, content, options) as Promise<HandlerRunOutcome>

export const settledWith = (session: RuntimeSession, thread: string): Promise<HandlerRunOutcome | undefined> =>
  session.settled(thread) as Promise<HandlerRunOutcome | undefined>

export const handlerOf = (execute: (state: ThreadState, message: Message) => Promise<void>, description?: string) =>
  defineHandler({ ...(description === undefined ? {} : { description }), execute })

export const executionSnapshot = (state: ThreadState) => {
  const e = state.execution
  return e === null
    ? null
    : {
        flowId: e.flowId,
        currentSide: e.currentSide,
        promptPath: [...e.promptPath],
        stepCount: e.stepCount,
        sideAStepCount: e.sideAStepCount,
        sideBStepCount: e.sideBStepCount,
      }
}
