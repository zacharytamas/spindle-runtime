import type { ExecutionState, Message, ThreadState, ToolResult } from "@standardagents/spec"
import { Context, Effect } from "effect"
import { type Definition, Registry } from "../registry/Registry.ts"
import type { Thread } from "../store/ThreadStore.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import { addSecret, type EnvScope, instanceEnv, lookupEnv, type Secrets } from "./env.ts"
import { copyMessage, type History } from "./history.ts"
import { type HookCall, HookExpired, type HookScope } from "./hooks.ts"
import { createMessage, updateMessage } from "./messages.ts"
import { lookup, type Side } from "./turn.ts"

export interface ExecutionRecord {
  readonly flowId: string
  readonly side: Side
  stepCount: number
  sideAStepCount: number
  sideBStepCount: number
  readonly abort: AbortController
  readonly promptPath: ReadonlyArray<string>
  readonly history: History
}

export interface StateContext {
  readonly thread: Thread
  readonly services: Context.Context<Registry | ThreadStore>
  readonly execution: ExecutionRecord | undefined
  readonly scope: EnvScope
  readonly from: Definition | undefined
  readonly context: Record<string, unknown>
  readonly secrets: Secrets
  readonly invoke: (name: string, args: Record<string, unknown>) => Effect.Effect<ToolResult>
  // The hooks that a message this state writes runs, the execution's set or the agent's set at rest.
  readonly hooks: HookScope
  // The hook call this state belongs to, when a hook gets it.
  readonly call?: HookCall
}

const notYet = (member: string, arrival: string) => () => {
  throw new Error(`ThreadState.${member} is not available in this version of Spindle. It arrives with ${arrival}.`)
}

const notYetAsync =
  (member: string, arrival: string) =>
  (..._args: ReadonlyArray<unknown>): Promise<never> =>
    Promise.reject(
      new Error(`ThreadState.${member} is not available in this version of Spindle. It arrives with ${arrival}.`),
    )

const executionState = (record: ExecutionRecord, readHistory: () => Array<Message>): ExecutionState => ({
  flowId: record.flowId,
  currentSide: record.side,
  get stepCount() {
    return record.stepCount
  },
  get sideAStepCount() {
    return record.sideAStepCount
  },
  get sideBStepCount() {
    return record.sideBStepCount
  },
  stopped: false,
  get messageHistory() {
    return readHistory()
  },
  forceTurn: notYet("execution.forceTurn", "M1-6"),
  stop: notYet("execution.stop", "M1-6"),
  abortSignal: record.abort.signal,
  promptPath: [...record.promptPath],
})

// The one place where Spindle runs an Effect for user code. Tools and hooks are Promise-based, and every ThreadState
// method they call runs here against the services of the execution.
export const makeThreadState = (state: StateContext): ThreadState => {
  const { call } = state
  const expired = () =>
    call?.expired === true ? new HookExpired({ hook: call.hook, position: call.position }) : undefined
  const runPromise = Effect.runPromiseWith(state.services)
  const run = <A, E>(effect: Effect.Effect<A, E, Registry | ThreadStore>): Promise<A> => {
    const refused = expired()
    return refused === undefined ? runPromise(effect) : Promise.reject(refused)
  }
  const registry = Context.get(state.services, Registry)
  const store = Context.get(state.services, ThreadStore)
  const threadId = state.thread.id
  // A read of the store finishes in the call that starts it, because no transaction spans an await. Each read gets
  // its own copy, so a tool or a hook that changes it changes nothing that a later read sees.
  const readHistory = (history: History) => () => {
    const refused = expired()
    if (refused !== undefined) throw refused
    return Effect.runSyncWith(state.services)(history.read).map(copyMessage)
  }
  const load = (kind: "model" | "prompt" | "agent") => (name: string) =>
    run(
      Effect.gen(function* () {
        const found = yield* lookup<unknown>(kind, name, state.from)
        if (found === undefined) return yield* Effect.fail(new Error(`No ${kind} named ${name} is defined`))
        return found.value
      }),
    ) as Promise<never>
  const names = (kind: "model" | "prompt" | "agent") => () =>
    registry.definitions.filter((definition) => definition.kind === kind).map((definition) => definition.qualifiedName)
  const write = { threadId, hooks: state.hooks, secrets: state.secrets, call, history: state.execution?.history }
  const remember = (value: string, barred: boolean) => {
    if (barred) addSecret(state.secrets, value)
    else state.secrets.values.add(value)
    return value
  }
  return {
    threadId,
    agentId: state.thread.agentId,
    userId: null,
    createdAt: state.thread.createdAt,
    children: [],
    terminated: state.thread.terminated,
    arguments: structuredClone(state.thread.arguments) as Record<string, unknown>,
    context: state.context,
    execution:
      state.execution === undefined ? null : executionState(state.execution, readHistory(state.execution.history)),

    getMessages: (options) => run(store.getMessages(threadId, options)),
    getMessage: (messageId) => run(store.getMessage(threadId, messageId)),
    injectMessage: (input) =>
      run(
        createMessage(
          write,
          {
            role: input.role,
            content: input.content,
            status: "completed",
            ...(input.silent === undefined ? {} : { silent: input.silent }),
            ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
          },
          "injection",
        ),
      ),
    updateMessage: (messageId, updates) => run(updateMessage(write, messageId, updates)),
    deleteMessage: (messageId) => run(store.deleteMessage(threadId, messageId)),
    queueMessage: notYetAsync("queueMessage", "M1-6"),

    loadModel: load("model"),
    loadPrompt: load("prompt"),
    loadAgent: load("agent"),
    getPromptNames: names("prompt"),
    getAgentNames: names("agent"),
    getModelNames: names("model"),

    getChildThread: () => Promise.resolve(null),
    getParentThread: () => Promise.resolve(null),
    notifyParent: notYetAsync("notifyParent", "M3, because this thread has no parent"),
    setStatus: () => Promise.resolve(),
    stopSession: notYetAsync("stopSession", "M2"),

    env: (name) =>
      run(
        Effect.gen(function* () {
          const found = yield* lookupEnv(state.scope, name)
          if (found === undefined) return yield* Effect.fail(new Error(`Environment variable ${name} has no value`))
          return remember(found.value, found.fromInstance || state.secrets.names.has(name))
        }),
      ),
    instanceEnv: (name) => run(Effect.map(instanceEnv(name), (value) => value && remember(value, true))),
    // Threads section 2.3: a value from any source but the thread is secret, and thread values arrive with setEnv.
    envType: () => Promise.resolve("secret"),
    setEnv: notYetAsync("setEnv", "M2"),

    queueTool: notYet("queueTool", "M1-6"),
    invokeTool: (toolName, args) => run(state.invoke(toolName, args)),

    scheduleEffect: notYetAsync("scheduleEffect", "M4"),
    getScheduledEffects: notYetAsync("getScheduledEffects", "M4"),
    removeScheduledEffect: notYetAsync("removeScheduledEffect", "M4"),
    runAgent: notYetAsync("runAgent", "M2"),
    terminate: notYetAsync("terminate", "M1-6"),
    // No client connects to a thread before the Thread Client API in M6, so an event has no receiver.
    emit: () => {},

    getValue: (key) => run(store.getValue(threadId, key)) as Promise<never>,
    setValue: (key, value) => run(store.setValue(threadId, key, value)),
    getUserValue: notYetAsync("getUserValue", "the Users page, which is a Draft"),
    setUserValue: notYetAsync("setUserValue", "the Users page, which is a Draft"),
    listUserValues: notYetAsync("listUserValues", "the Users page, which is a Draft"),
    user: () => Promise.resolve(null),
    skills: {
      list: notYetAsync("skills.list", "M7"),
      get: notYetAsync("skills.get", "M7"),
      readFile: notYetAsync("skills.readFile", "M7"),
      install: notYetAsync("skills.install", "M7"),
      setEnabled: notYetAsync("skills.setEnabled", "M7"),
      remove: notYetAsync("skills.remove", "M7"),
    },

    writeFile: notYetAsync("writeFile", "M3"),
    readFile: notYetAsync("readFile", "M3"),
    readFileStream: notYetAsync("readFileStream", "M3"),
    statFile: notYetAsync("statFile", "M3"),
    readdirFile: notYetAsync("readdirFile", "M3"),
    unlinkFile: notYetAsync("unlinkFile", "M3"),
    mkdirFile: notYetAsync("mkdirFile", "M3"),
    rmdirFile: notYetAsync("rmdirFile", "M3"),
    moveFile: notYetAsync("moveFile", "M3"),
    renameFile: notYetAsync("renameFile", "M3"),
    getFileStats: notYetAsync("getFileStats", "M3"),
    grepFiles: notYetAsync("grepFiles", "M3"),
    findFiles: notYetAsync("findFiles", "M3"),
    getFileThumbnail: notYetAsync("getFileThumbnail", "M3"),

    status: notYetAsync("status", "M1-6"),
    decide: notYetAsync("decide", "M4"),
    runCode: notYet("runCode", "M5"),
  }
}
