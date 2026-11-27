import type {
  ExecutionState,
  Message,
  QueueMessageInput,
  ThreadState,
  ThreadStatus,
  ToolResult,
} from "@standardagents/spec"
import { Cause, Context, Data, Effect, Exit, Predicate } from "effect"
import type { SqlError } from "effect/sql/SqlError"
import type { Definition } from "../registry/definition.ts"
import { Registry } from "../registry/Registry.ts"
import { toJson } from "../store/json.ts"
import { MessageStore } from "../store/MessageStore.ts"
import {
  type FlowEnded,
  HandleExpired,
  type Thread,
  type ThreadNotFound,
  type ThreadTerminated,
  ValueNotJson,
  type WriteOrigin,
} from "../store/model.ts"
import type { Stores } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import type { Callback } from "./callback.ts"
import type { Execution } from "./Execution.ts"
import { addSecret, type EnvScope, instanceEnv, lookupEnv, type Secrets } from "./env.ts"
import { copyMessage, type History } from "./history.ts"
import { type HookCall, HookExpired, type HookScope, type HookSet } from "./hooks.ts"
import { injectMessage, updateMessage } from "./messages.ts"
import { mapStrings } from "./redact.ts"
import { type QueueRefused, queueTarget } from "./tools.ts"
import { type FunctionTool, type Loaded, lookup, type Side } from "./turn.ts"

interface ExecutionRecord {
  readonly side: Side
  readonly promptPath: ReadonlyArray<string>
  readonly history: History
  readonly run: Execution
}

// The members of ThreadState that reach past one execution: the queue, the run status, and termination. An execution
// that one of them starts runs with the services of the caller.
type WriteError = ThreadNotFound | SqlError | FlowEnded | ThreadTerminated | HandleExpired
export type AdmissionError = WriteError | ValueNotJson

export interface ThreadControl {
  readonly queueMessage: (
    input: QueueMessageInput,
    secrets: Secrets,
    origin: WriteOrigin,
  ) => Effect.Effect<void, AdmissionError | QueueRefused, Registry | Stores>
  // The target is the qualified name of a function tool that queueTarget allowed.
  readonly queueTool: (
    target: string,
    args: Record<string, unknown>,
    origin: WriteOrigin,
  ) => Effect.Effect<void, AdmissionError, Registry | Stores>
  readonly status: Effect.Effect<ThreadStatus, ThreadNotFound | SqlError>
  readonly terminate: (origin: WriteOrigin) => Effect.Effect<number, WriteError>
}

class ExecutionEnded extends Data.TaggedError("ExecutionEnded")<{ readonly flowId: string }> {
  override get message() {
    return `Execution ${this.flowId} has ended, so Spindle refused this call from a ThreadState that belongs to it`
  }
}

class SecretInArguments extends Data.TaggedError("SecretInArguments") {
  override get message() {
    return "queueTool arguments contain a secret"
  }
}

class InvalidArguments extends Data.TaggedError("InvalidArguments")<{ readonly message: string }> {}

interface StateContext {
  readonly thread: Thread
  readonly services: Context.Context<Registry | Stores>
  readonly callback?: Callback
  readonly owner?: Execution
  readonly execution: ExecutionRecord | undefined
  readonly scope: EnvScope
  readonly from: Definition | undefined
  readonly context: Record<string, unknown>
  readonly secrets: Secrets
  readonly invoke?: (name: string, args: Record<string, unknown>) => Effect.Effect<ToolResult>
  // The hooks that a message this state writes runs, the execution's set or the agent's set at rest.
  readonly hooks: HookScope
  // The hook call this state belongs to, when a hook gets it.
  readonly call?: HookCall
  readonly control: ThreadControl
  // The tool whose ThreadState this is. Its uses list limits what queueTool and invokeTool reach.
  readonly caller?: Loaded<FunctionTool>
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

const executionState = (
  record: ExecutionRecord,
  readHistory: () => Array<Message>,
  check: () => void,
): ExecutionState => {
  const state: ExecutionState = {
    flowId: record.run.flowId,
    currentSide: record.side,
    get stepCount() {
      return record.run.steps
    },
    get sideAStepCount() {
      return record.side === "a" ? record.run.steps : 0
    },
    get sideBStepCount() {
      return record.side === "b" ? record.run.steps : 0
    },
    get stopped() {
      return record.run.stopAtBoundary() !== undefined
    },
    get messageHistory() {
      return readHistory()
    },
    forceTurn: () => {
      check()
      return notYet("execution.forceTurn", "M2")()
    },
    stop: () => {
      check()
      record.run.requestStop(record.side)
    },
    abortSignal: record.run.signal,
    promptPath: [...record.promptPath],
  }
  // stoppedBy is absent until a stop, and a stop from outside comes from the side that is not running.
  Object.defineProperty(state, "stoppedBy", {
    enumerable: true,
    get: () => {
      return record.run.stopAtBoundary() !== undefined
        ? (record.run.stoppedBy ?? (record.side === "a" ? "b" : "a"))
        : undefined
    },
  })
  return state
}

// The one place where Spindle runs an Effect for user code. Tools and hooks are Promise-based, and every ThreadState
// method they call runs here against the services of the execution.
export const makeThreadState = (state: StateContext): ThreadState => {
  const { call } = state
  const owner = state.owner ?? state.execution?.run
  const expired = () =>
    call?.expired === true
      ? new HookExpired({ hook: call.hook, position: call.position })
      : (state.callback ?? call)?.finished
        ? new HandleExpired()
        : owner?.ended === true
          ? new ExecutionEnded({ flowId: owner.flowId })
          : owner?.signal.aborted
            ? new HandleExpired()
            : undefined
  const check = () => {
    const refusal = expired()
    if (refusal) throw refusal
  }
  const unavailable = (member: string, arrival: string) => () => {
    check()
    return notYet(member, arrival)()
  }
  const unavailableAsync = (member: string, arrival: string) => async () => {
    check()
    return notYetAsync(member, arrival)()
  }
  const services = state.services
  const origin: WriteOrigin = {
    kind: "handle",
    flowId: owner?.flowId ?? null,
    terminated: state.thread.terminated,
    expired: () => expired() !== undefined,
  }
  const runPromise = Effect.runPromiseWith(services)
  // A call from a ThreadState of an execution ends when the execution is aborted, so terminate stops what it started.
  const signal = owner === undefined ? undefined : { signal: owner.signal }
  const run = <A, E>(effect: Effect.Effect<A, E, Registry | Stores>): Promise<A> => {
    const refused = expired()
    return refused === undefined ? runPromise(effect, signal) : Promise.reject(refused)
  }
  // queueTool returns void, so its work is done when it returns, and a refusal is thrown.
  const runSync = <A, E>(effect: Effect.Effect<A, E, Registry | Stores>): A => {
    const refused = expired()
    if (refused !== undefined) throw refused
    const exit = Effect.runSyncExitWith(services)(effect)
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
  }
  const registry = Context.get(state.services, Registry)
  const messageStore = Context.get(state.services, MessageStore)
  const threadStore = Context.get(state.services, ThreadStore)
  const threadId = state.thread.id
  // A read of the store finishes in the call that starts it, because no transaction spans an await. Each read gets
  // its own copy, so a tool or a hook that changes it changes nothing that a later read sees.
  const readHistory = (history: History) => () => {
    check()
    return Effect.runSyncWith(state.services)(history.read).rows.map(({ message }) => copyMessage(message))
  }
  const load = (kind: "model" | "prompt" | "agent") => (name: string) =>
    run(lookup<unknown>(kind, name, state.from)).then((found) => {
      if (found === undefined) throw new Error(`No ${kind} named ${name} is defined`)
      return found.value
    }) as Promise<never>
  const names = (kind: "model" | "prompt" | "agent") => () => {
    check()
    return registry.definitions
      .filter((definition) => definition.kind === kind)
      .map((definition) => definition.qualifiedName)
  }
  const write = {
    threadId,
    hooks: state.hooks,
    secrets: state.secrets,
    call,
    history: state.execution?.history,
    origin,
  }
  const remember = (value: string, barred: boolean) => {
    if (barred) addSecret(state.secrets, value)
    else state.secrets.values.add(value)
    return value
  }
  let terminated = state.thread.terminated
  return {
    threadId,
    agentId: state.thread.agentId,
    userId: null,
    createdAt: state.thread.createdAt,
    children: [],
    get terminated() {
      return terminated
    },
    arguments: structuredClone(state.thread.arguments) as Record<string, unknown>,
    context: state.context,
    execution:
      state.execution === undefined
        ? null
        : executionState(state.execution, readHistory(state.execution.history), check),

    getMessages: (options) => run(messageStore.getMessages(threadId, options)),
    getMessage: (messageId) => run(messageStore.getMessage(threadId, messageId)),
    injectMessage: (input) =>
      run(
        injectMessage(write, {
          role: input.role,
          content: input.content,
          status: "completed",
          ...(input.silent === undefined ? {} : { silent: input.silent }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        }).pipe(Effect.map((inserted) => inserted.message)),
      ),
    updateMessage: (messageId, updates) => run(updateMessage(write, messageId, updates)),
    deleteMessage: (messageId) => run(messageStore.deleteMessage(threadId, messageId, origin)),
    queueMessage: (input) => run(state.control.queueMessage(input, state.secrets, origin)),

    loadModel: load("model"),
    loadPrompt: load("prompt"),
    loadAgent: load("agent"),
    getPromptNames: names("prompt"),
    getAgentNames: names("agent"),
    getModelNames: names("model"),

    getChildThread: () => run(Effect.succeed(null)),
    getParentThread: () => run(Effect.succeed(null)),
    notifyParent: unavailableAsync("notifyParent", "M3, because this thread has no parent"),
    setStatus: () => run(Effect.void),
    stopSession: unavailableAsync("stopSession", "M2"),

    env: (name) =>
      run(
        Effect.map(
          lookupEnv(state.scope, name),
          (found) => found && remember(found.value, found.fromInstance || state.secrets.names.has(name)),
        ),
      ).then((value) => {
        if (value === undefined) throw new Error(`Environment variable ${name} has no value`)
        return value
      }),
    instanceEnv: (name) => run(Effect.map(instanceEnv(name), (value) => value && remember(value, true))),
    // Threads section 2.3: a value from any source but the thread is secret, and thread values arrive with setEnv.
    envType: () => run(Effect.succeed("secret" as const)),
    setEnv: unavailableAsync("setEnv", "M2"),

    // Threads section 3.1 and Tools section 2.1. The constrained ThreadState of a tool with a uses list lets it leave
    // out the arguments.
    queueTool: (toolName, args) =>
      runSync(
        Effect.gen(function* () {
          const given: unknown = args === undefined ? {} : args
          if (!Predicate.isObject(given))
            return yield* new InvalidArguments({
              message: `queueTool(${String(toolName)}) takes an object of arguments`,
            })
          const target = yield* queueTarget(state.caller, state.from, toolName)
          const encoded = toJson(given)
          if (typeof encoded !== "string") return yield* new ValueNotJson({ field: "queued arguments", ...encoded })
          const plain = JSON.parse(encoded)
          if (state.secrets.values.size) {
            let found = false
            const check = (text: string) => {
              for (const secret of state.secrets.values) if (secret && text.includes(secret)) found = true
              return text
            }
            mapStrings(plain, check, check)
            if (found) return yield* new SecretInArguments()
          }
          yield* state.control.queueTool(target, plain, origin)
        }),
      ),
    invokeTool: (toolName, args) =>
      run(
        state.invoke
          ? state.invoke(toolName, args)
          : Effect.succeed({
              status: "error",
              error: `invokeTool(${toolName}) needs a calling tool and its uses list`,
            }),
      ),

    scheduleEffect: unavailableAsync("scheduleEffect", "M4"),
    getScheduledEffects: unavailableAsync("getScheduledEffects", "M4"),
    removeScheduledEffect: unavailableAsync("removeScheduledEffect", "M4"),
    runAgent: unavailableAsync("runAgent", "M2"),
    // The termination aborts the execution that this state may belong to, so the call itself is not bound to it.
    terminate: () =>
      runPromise(state.control.terminate(origin)).then((time) => {
        terminated = time
      }),
    // No client connects to a thread before the Thread Client API in M6, so an event has no receiver.
    emit: check,

    getValue: (key) => run(threadStore.getValue(threadId, key)) as Promise<never>,
    setValue: (key, value) => run(threadStore.setValue(threadId, key, value, origin)),
    getUserValue: unavailableAsync("getUserValue", "the Users page, which is a Draft"),
    setUserValue: unavailableAsync("setUserValue", "the Users page, which is a Draft"),
    listUserValues: unavailableAsync("listUserValues", "the Users page, which is a Draft"),
    user: () => run(Effect.succeed(null)),
    skills: {
      list: unavailableAsync("skills.list", "M7"),
      get: unavailableAsync("skills.get", "M7"),
      readFile: unavailableAsync("skills.readFile", "M7"),
      install: unavailableAsync("skills.install", "M7"),
      setEnabled: unavailableAsync("skills.setEnabled", "M7"),
      remove: unavailableAsync("skills.remove", "M7"),
    },

    writeFile: unavailableAsync("writeFile", "M3"),
    readFile: unavailableAsync("readFile", "M3"),
    readFileStream: unavailableAsync("readFileStream", "M3"),
    statFile: unavailableAsync("statFile", "M3"),
    readdirFile: unavailableAsync("readdirFile", "M3"),
    unlinkFile: unavailableAsync("unlinkFile", "M3"),
    mkdirFile: unavailableAsync("mkdirFile", "M3"),
    rmdirFile: unavailableAsync("rmdirFile", "M3"),
    moveFile: unavailableAsync("moveFile", "M3"),
    renameFile: unavailableAsync("renameFile", "M3"),
    getFileStats: unavailableAsync("getFileStats", "M3"),
    grepFiles: unavailableAsync("grepFiles", "M3"),
    findFiles: unavailableAsync("findFiles", "M3"),
    getFileThumbnail: unavailableAsync("getFileThumbnail", "M3"),

    status: () => run(state.control.status),
    decide: unavailableAsync("decide", "M4"),
    runCode: unavailable("runCode", "M5"),
  }
}

// At rest a caller shares its context with the creation hooks. Each inbound delivery hook gets a fresh context.
export function atRestHooks(
  base: Pick<StateContext, "thread" | "services" | "scope" | "secrets" | "control" | "owner"> & {
    context?: Record<string, unknown>
  },
  set: HookSet,
): HookScope {
  const hooks: HookScope = {
    ...(base.owner && { execution: base.owner }),
    set,
    stateFor: (hook, call) =>
      makeThreadState({
        ...base,
        execution: undefined,
        context: base.context ?? {},
        from: hook.definition,
        hooks,
        call,
      }),
  }
  return hooks
}
