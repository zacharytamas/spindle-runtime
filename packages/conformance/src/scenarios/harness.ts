import {
  type AgentDefinition,
  defineAgent,
  defineModel,
  definePrompt,
  defineTool,
  type Message,
  type ModelDefinition,
  type PromptDefinition,
  type ProviderMessage,
} from "@standardagents/spec"
import type { LoadOptions, Project, RuntimeDriver, RuntimeSession, SendOptions } from "../RuntimeDriver.ts"
import type { RecordedRequest, ScriptedProvider } from "../ScriptedProvider.ts"

export interface Scenario {
  readonly name: string
  // The requirement ids, without the page prefix, that the scenario proves. The ledger holds the full ids.
  readonly requirements: ReadonlyArray<string>
  readonly run: (driver: RuntimeDriver) => Promise<void>
}

export interface Setup {
  readonly provider: ScriptedProvider
  readonly prompt?: Partial<PromptDefinition>
  readonly prompts?: ReadonlyArray<PromptDefinition>
  readonly side?: Partial<AgentDefinition["sideA"]>
  readonly agent?: Partial<AgentDefinition>
  readonly agents?: ReadonlyArray<AgentDefinition>
  readonly humanOn?: "a" | "b"
  readonly model?: Partial<ModelDefinition>
  readonly models?: ReadonlyArray<ModelDefinition>
  readonly tools?: Project["tools"]
  readonly hooks?: Project["hooks"]
}

export const project = (setup: Setup): Project => {
  const side = { prompt: "assistant", ...setup.side } as AgentDefinition["sideA"]
  const human = { human: true } as const
  return {
    models: [
      defineModel({ name: "scripted", provider: setup.provider.factory, model: "scripted-model-v1", ...setup.model }),
      ...(setup.models ?? []),
    ],
    prompts: [
      definePrompt({
        name: "assistant",
        toolDescription: "Answers questions",
        model: "scripted",
        prompt: "You are a test assistant.",
        tools: Object.keys(setup.tools ?? {}),
        ...setup.prompt,
      } as PromptDefinition),
      ...(setup.prompts ?? []),
    ],
    agents: [
      defineAgent({
        name: "assistant",
        ...(setup.humanOn === "a" ? { sideA: human, sideB: side } : { sideA: side, sideB: human }),
        ...setup.agent,
      } as AgentDefinition),
      ...(setup.agents ?? []),
    ],
    tools: setup.tools ?? {},
    ...(setup.hooks === undefined ? {} : { hooks: setup.hooks }),
  }
}

export const using = async <A>(
  driver: RuntimeDriver,
  setup: Setup,
  body: (session: RuntimeSession, thread: string) => Promise<A>,
  options?: LoadOptions,
): Promise<A> => {
  const session = await driver.load(project(setup), options)
  try {
    return await body(session, await session.createThread("assistant"))
  } finally {
    await session.close()
  }
}

export const runTurn = (driver: RuntimeDriver, setup: Setup, text: string, options?: SendOptions) =>
  using(driver, setup, (session, thread) => session.send(thread, text, options))

export const usingPeer = async (
  driver: RuntimeDriver,
  setup: Setup,
  body: (session: RuntimeSession, thread: string, peer: RuntimeSession) => Promise<void>,
  options: LoadOptions = {},
) => {
  const session = await driver.load(project(setup), options)
  const peer = await session.peer()
  try {
    await body(session, await session.createThread("assistant"), peer)
  } finally {
    await peer.close()
    await session.close()
  }
}

// What a call on a ThreadState did: "done", or the tag of the typed error it failed with.
export const attempt = async (call: () => unknown): Promise<string> => {
  try {
    await call()
    return "done"
  } catch (error) {
    return typeof error === "object" && error !== null && "_tag" in error
      ? String(error._tag)
      : `untyped: ${error instanceof Error ? error.message : String(error)}`
  }
}

// A send that a failed expectation leaves behind is rejected when its session closes. Nothing awaits it then.
export const quiet = <A>(promise: Promise<A>): Promise<A> => {
  promise.catch(() => undefined)
  return promise
}

export const gate = () => {
  let release: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    release = resolve
  })
  return { release, opened }
}

export const ok = (result: string) => ({ status: "success" as const, result })

export const callsOf = (message: Message | undefined) =>
  JSON.parse(message?.tool_calls ?? "[]") as Array<{
    id: string
    type: string
    function: { name: string; arguments: string }
  }>

// Every key and string inside a value, and inside each string that holds JSON, so that a search finds a value under
// any field and inside a JSON column, decoded.
const stringsIn = (value: unknown): Array<string> => {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value)
      return [value, ...(typeof parsed === "object" && parsed !== null ? stringsIn(parsed) : [])]
    } catch {
      return [value]
    }
  }
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, member]) => [key, ...stringsIn(member)])
}

export const holding = (value: unknown, secret: string) => stringsIn(value).filter((text) => text.includes(secret))

export const shape = (messages: ReadonlyArray<Message>) =>
  messages.map((message) => [message.role, message.role === "tool" ? message.tool_call_id : message.content])

export const history = (request: RecordedRequest | undefined) =>
  (request?.messages ?? []).filter((message) => message.role !== "system")

export const sideOf = (message: ProviderMessage) =>
  message.role === "assistant"
    ? ["assistant", message.content ?? null, (message.toolCalls ?? []).map((call) => call.id)]
    : message.role === "tool"
      ? ["tool", message.toolCallId]
      : [message.role, message.content]

export const counter = () => {
  let count = 0
  return {
    get count() {
      return count
    },
    tick: <A>(value: A) => {
      count += 1
      return value
    },
  }
}

export const statusOf = async (session: RuntimeSession, thread: string) => (await session.state(thread)).status()

export const SIDES = ["b", "a"] as const

// The human's stored role and the model side's stored role. Messages section 4: user is side B, assistant is side A.
export const rolesFor = (humanOn: "a" | "b") =>
  humanOn === "b" ? ({ human: "user", model: "assistant" } as const) : ({ human: "assistant", model: "user" } as const)

export const stubTool = (description: string, result: string) =>
  defineTool({ description, execute: async () => ok(result) })

export const toolResults = <M extends { readonly role: string }>(messages: ReadonlyArray<M>) =>
  messages.filter((message) => message.role === "tool")
export const firstToolResult = (messages: ReadonlyArray<Message>) => messages.find((message) => message.role === "tool")

// Give asynchronous admissions the same bounded wait before inspecting the outcome.
export const waitForAdmission = async (admitted: () => Promise<boolean>) => {
  for (let tries = 0; tries < 500; tries++) {
    if (await admitted()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
