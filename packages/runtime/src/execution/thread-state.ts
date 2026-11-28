import type {
  AttachmentRef,
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
  FlowEnded,
  HandleExpired,
  type Thread,
  type ThreadBusy,
  type ThreadNotFound,
  type ThreadTerminated,
  ValueNotJson,
  type WriteOrigin,
} from "../store/model.ts"
import { isAttachmentRef } from "../store/schema.ts"
import type { Stores } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import type { Callback } from "./callback.ts"
import type { Execution } from "./Execution.ts"
import { addSecret, type EnvScope, instanceEnv, lookupEnv, type Secrets } from "./env.ts"
import { copyMessage, type History } from "./history.ts"
import { type HookCall, HookExpired, type HookScope } from "./hooks.ts"
import { injectMessage, redactMetadata, updateMessage, type WriteContext } from "./messages.ts"
import { isPlain, mapStrings, redactor } from "./redact.ts"
import type { InvalidOption } from "./ThreadSupervisor.ts"
import {
  describe,
  failed,
  invokeTool,
  notRun,
  QueueRefused,
  queueTarget,
  redactAttachment,
  type ToolContext,
} from "./tools.ts"
import { type FunctionTool, type Loaded, lookup, otherSide, SetupError } from "./turn.ts"

interface ExecutionRecord {
  readonly toolContext: ToolContext
  readonly history: History
  readonly run: Execution
}

// The members of ThreadState that reach past one execution: the queue, the run status, and termination. An execution
// that one of them starts runs with the services of the caller.
type WriteError = ThreadNotFound | SqlError | FlowEnded | ThreadTerminated | HandleExpired
export type AdmissionError = WriteError | ValueNotJson | InvalidOption

export interface DirectCall {
  readonly from: Definition | undefined
  readonly name: string
  readonly args: Record<string, unknown>
  readonly writeCall: WriteContext["call"]
}

export interface ThreadControl {
  readonly direct: (
    call: DirectCall,
    origin: WriteOrigin,
  ) => Effect.Effect<ToolResult, WriteError | ThreadBusy | SetupError, Registry | Stores>
  readonly runAgent: (agentName: string, origin: WriteOrigin) => Effect.Effect<void, AdmissionError, Registry | Stores>
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
    side?: "a" | "b" | null,
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

const invalid = (message: string): Promise<never> => Promise.reject(new InvalidArguments({ message }))
const isRecord = (value: unknown) => Predicate.isObject(value) && isPlain(value)

// Messages section 4. A queued message is user code's text, so it is redacted before the queue stores it. A new file
// needs the thread file system, which arrives in M3.
export const queuedMessage = (input: QueueMessageInput, secrets: Secrets) =>
  Effect.gen(function* () {
    const refuse = (problem: string) => new QueueRefused({ message: `queueMessage ${problem}` })
    if (!Predicate.isObject(input)) return yield* refuse("takes an object with a role and content")
    if (input.role !== "user" && input.role !== "assistant") return yield* refuse("takes the role user or assistant")
    if (typeof input.content !== "string") return yield* refuse("takes content that is a string")
    if (input.silent !== undefined && typeof input.silent !== "boolean")
      return yield* refuse("takes silent as a boolean")
    if (input.metadata !== undefined && !Predicate.isObject(input.metadata))
      return yield* refuse("takes metadata as an object")
    const attachments: ReadonlyArray<unknown> = input.attachments === undefined ? [] : input.attachments
    if (!Array.isArray(attachments)) return yield* refuse("takes attachments as an array")
    for (const item of attachments)
      if (!isAttachmentRef(item))
        return yield* refuse(
          Predicate.isObject(item) && typeof item.data === "string"
            ? "cannot store a new file in this version of Spindle. The thread file system arrives in M3, so pass a reference to a stored file."
            : "takes attachments that are references to stored files",
        )
    const redact = redactor(secrets.values)
    return {
      role: input.role,
      content: redact(input.content),
      ...(input.silent === undefined ? {} : { silent: input.silent }),
      ...(input.metadata === undefined ? {} : { metadata: redactMetadata(input.metadata, redact) }),
      ...(attachments.length === 0
        ? {}
        : {
            attachments: attachments.map((item) =>
              redactAttachment(item as Record<string, unknown>, redact),
            ) as Array<AttachmentRef>,
          }),
    } satisfies QueueMessageInput
  })

interface StateContext {
  readonly thread: Thread
  readonly services: Context.Context<Registry | Stores>
  readonly callback?: Callback
  readonly execution: ExecutionRecord | undefined
  readonly scope: EnvScope
  readonly from: Definition | undefined
  readonly context: Record<string, unknown>
  readonly secrets: Secrets
  readonly writeCall?: WriteContext["call"]
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
    get currentSide() {
      return record.run.currentSide
    },
    get stepCount() {
      return record.run.steps
    },
    get sideAStepCount() {
      return record.run.sideASteps
    },
    get sideBStepCount() {
      return record.run.sideBSteps
    },
    get stopped() {
      return record.run.stopAtBoundary() !== undefined
    },
    get messageHistory() {
      return readHistory()
    },
    forceTurn: (side) => {
      check()
      if (side !== "a" && side !== "b") throw new InvalidArguments({ message: "forceTurn takes the side a or b" })
      if (record.run.directSide === undefined) record.run.turns.pending = side
    },
    stop: () => {
      check()
      record.run.requestStop(state.currentSide)
    },
    abortSignal: record.run.signal,
    get promptPath() {
      const active = record.run.turns.active
      return active?.kind === "prompt" ? [active.prompt.qualifiedName] : []
    },
  }
  // stoppedBy is absent until a stop, and a stop from outside comes from the side that is not running.
  Object.defineProperty(state, "stoppedBy", {
    enumerable: true,
    get: () => {
      return record.run.stopAtBoundary() !== undefined
        ? (record.run.stoppedBy ?? otherSide(state.currentSide))
        : undefined
    },
  })
  return state
}

// The one place where Spindle runs an Effect for user code. Tools and hooks are Promise-based, and every ThreadState
// method they call runs here against the services of the execution.
const stateBridge = (state: StateContext) => {
  const { call } = state
  const owner = state.execution?.run
  const expired = () =>
    call?.expired === true
      ? new HookExpired({ hook: call.hook, position: call.position })
      : state.callback?.pastDeadline || (state.callback ?? call)?.finished
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
    if (refused) return Promise.reject(refused)
    const pending = runPromise(effect, signal)
    if (!owner?.directSide) return pending
    return pending.catch(async (error: unknown) => {
      // A termination can interrupt a pre-commit hook before its write reaches SQLite.
      if (
        owner.signal.aborted &&
        (await runPromise(Context.get(services, ThreadStore).getThread(state.thread.id))).terminated !== null
      )
        throw new FlowEnded({ threadId: state.thread.id, flowId: owner.flowId, why: "terminated" })
      throw error
    })
  }
  // queueTool returns void, so its work is done when it returns, and a refusal is thrown.
  const runSync = <A, E>(effect: Effect.Effect<A, E, Registry | Stores>): A => {
    const refused = expired()
    if (refused !== undefined) throw refused
    const exit = Effect.runSyncExitWith(services)(effect)
    if (Exit.isSuccess(exit)) return exit.value
    throw Cause.squash(exit.cause)
  }
  return { check, origin, run, runSync, runPromise, signal }
}

type Bridge = ReturnType<typeof stateBridge>

function messageQuery(
  messageStore: Context.Service.Shape<typeof MessageStore>,
  threadId: string,
  run: Bridge["run"],
): ThreadState["getMessages"] {
  return async (options = {}) => {
    if (!Predicate.isObject(options)) return invalid("getMessages takes an options object")
    const { order = "desc", includeSilent = false, limit, offset = 0, maxDepth } = options
    if (order !== "asc" && order !== "desc") return invalid("order must be asc or desc")
    if (typeof includeSilent !== "boolean") return invalid("includeSilent must be boolean")
    if (limit !== undefined && typeof limit !== "number") return invalid("limit must be a number")
    if (typeof offset !== "number") return invalid("offset must be a number")
    if (maxDepth !== undefined && typeof maxDepth !== "number") return invalid("maxDepth must be a number")
    return run(
      messageStore.getMessages(threadId, {
        order,
        includeSilent,
        offset,
        ...(limit !== undefined && { limit }),
        ...(maxDepth !== undefined && { maxDepth }),
      }),
    )
  }
}

function messageMethods(
  state: StateContext,
  { run, origin }: Bridge,
): Pick<
  ThreadState,
  "getMessages" | "getMessage" | "injectMessage" | "updateMessage" | "deleteMessage" | "queueMessage"
> {
  const messageStore = Context.get(state.services, MessageStore)
  const threadId = state.thread.id
  const write = {
    threadId,
    hooks: state.hooks,
    secrets: state.secrets,
    call: state.call ?? state.writeCall,
    history: state.execution?.history,
    origin,
  }
  return {
    getMessages: messageQuery(messageStore, threadId, run),
    getMessage: (id) =>
      typeof id === "string" ? run(messageStore.getMessage(threadId, id)) : invalid("getMessage takes a string id"),
    injectMessage: async (input) => {
      if (!Predicate.isObject(input)) return invalid("injectMessage takes a message object")
      const { role, content, silent, metadata } = input
      if (role !== "user" && role !== "assistant" && role !== "system")
        return invalid("injectMessage takes the role user, assistant or system")
      if (typeof content !== "string") return invalid("injectMessage takes string content")
      if (silent !== undefined && typeof silent !== "boolean") return invalid("silent must be boolean")
      if (metadata !== undefined && !isRecord(metadata)) return invalid("metadata must be an object")
      return run(
        injectMessage(write, {
          role,
          content,
          ...(silent !== undefined && { silent }),
          ...(metadata !== undefined && { metadata }),
          status: "completed",
        }).pipe(Effect.map((inserted) => inserted.message)),
      )
    },
    updateMessage: async (id, updates) => {
      if (typeof id !== "string") return invalid("updateMessage takes a string id")
      if (!Predicate.isObject(updates)) return invalid("updateMessage takes an updates object")
      const patch = { ...updates }
      if (patch.content !== undefined && typeof patch.content !== "string") return invalid("content must be a string")
      if (patch.metadata !== undefined && !isRecord(patch.metadata)) return invalid("metadata must be an object")
      return run(updateMessage(write, id, patch))
    },
    deleteMessage: (id) =>
      typeof id === "string"
        ? run(
            Effect.tap(messageStore.deleteMessage(threadId, id, origin), (removed) =>
              Effect.sync(() => {
                if (removed) write.history?.deleted(id)
              }),
            ),
          )
        : invalid("deleteMessage takes a string id"),
    queueMessage: (input) => run(state.control.queueMessage(input, state.secrets, origin)),
  }
}

function definitions(state: StateContext, { run, check }: Bridge) {
  const registry = Context.get(state.services, Registry)
  const load =
    (kind: "model" | "prompt" | "agent") =>
    <T = unknown>(name: string) => {
      if (typeof name !== "string") return invalid(`load ${kind} takes a string name`)
      return run(lookup(kind, name, state.from)).then((found) => {
        if (found === undefined) throw new Error(`No ${kind} named ${name} is defined`)
        return found.value as T
      })
    }
  const names = (kind: "model" | "prompt" | "agent") => () => {
    check()
    return registry.definitions
      .filter((definition) => definition.kind === kind)
      .map((definition) => definition.qualifiedName)
  }
  return {
    loadModel: load("model"),
    loadPrompt: load("prompt"),
    loadAgent: load("agent"),
    getPromptNames: names("prompt"),
    getAgentNames: names("agent"),
    getModelNames: names("model"),
  }
}

function environment(state: StateContext, { run }: Bridge): Pick<ThreadState, "env" | "instanceEnv" | "envType"> {
  const remember = (value: string, barred: boolean) => {
    if (barred) addSecret(state.secrets, value)
    else state.secrets.values.add(value)
    return value
  }
  return {
    env: (name) => {
      if (typeof name !== "string") return invalid("env takes a string name")
      return run(
        Effect.map(
          lookupEnv(state.scope, name),
          (found) => found && remember(found.value, found.fromInstance || state.secrets.names.has(name)),
        ),
      ).then((value) => {
        if (value === undefined) throw new Error(`Environment variable ${name} has no value`)
        return value
      })
    },
    instanceEnv: (name) =>
      typeof name !== "string"
        ? invalid("instanceEnv takes a string name")
        : run(Effect.map(instanceEnv(name), (value) => value && remember(value, true))),
    // Threads section 2.3: a value from any source but the thread is secret, and thread values arrive with setEnv.
    envType: (name) =>
      typeof name !== "string" ? invalid("envType takes a string name") : run(Effect.succeed("secret" as const)),
  }
}

function toolMethods(
  state: StateContext,
  { check, runPromise, runSync, signal, origin }: Bridge,
): Pick<ThreadState, "invokeTool" | "queueTool"> {
  return {
    // Threads section 3.1 and Tools section 2.1. The constrained ThreadState of a tool with a uses list lets it leave
    // out the arguments.
    queueTool: (toolName, args) =>
      runSync(
        Effect.gen(function* () {
          if (typeof toolName !== "string")
            return yield* new InvalidArguments({ message: "queueTool takes a string name" })
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
          yield* state.control.queueTool(target, plain, origin, state.execution?.run.currentSide ?? null)
        }),
      ),
    // A nested call is pending from here, before its lookup and its validation, so the run waits for it.
    invokeTool: async (toolName, input) => {
      const args = input === undefined && state.caller ? {} : input
      if (typeof toolName !== "string") return invalid("invokeTool takes a string name")
      if (!Predicate.isObject(args)) return invalid("invokeTool takes an object of arguments")
      check()
      const writeCall = state.call ?? state.writeCall
      if (!state.execution)
        return runPromise(state.control.direct({ name: toolName, args, from: state.from, writeCall }, origin))
      const { run: owner, toolContext } = state.execution
      const release = owner.track(`tool ${toolName}`)
      let entered = false
      try {
        if (owner.stopAtBoundary()) return notRun
        const result = await runPromise(
          invokeTool(
            toolContext,
            state.from,
            state.caller,
            toolName,
            args,
            () => {
              entered = true
            },
            writeCall,
          ),
          signal,
        )
        return !entered && owner.stopAtBoundary() ? notRun : result
      } catch (error) {
        if (entered) throw error
        return owner.signal.aborted || owner.stopAtBoundary()
          ? notRun
          : failed(`Preparing tool ${toolName} threw: ${describe(error)}`)
      } finally {
        release()
      }
    },
  }
}

function unavailableMethods(check: () => void) {
  const unavailable = (member: string, arrival: string) => () => {
    check()
    return notYet(member, arrival)()
  }
  const unavailableAsync = (member: string, arrival: string) => async () => {
    check()
    return notYetAsync(member, arrival)()
  }
  return {
    notifyParent: unavailableAsync("notifyParent", "M3, because this thread has no parent"),

    setEnv: unavailableAsync("setEnv", "M2"),
    scheduleEffect: unavailableAsync("scheduleEffect", "M4"),
    getScheduledEffects: unavailableAsync("getScheduledEffects", "M4"),
    removeScheduledEffect: unavailableAsync("removeScheduledEffect", "M4"),

    getUserValue: unavailableAsync("getUserValue", "the Users page, which is a Draft"),
    setUserValue: unavailableAsync("setUserValue", "the Users page, which is a Draft"),
    listUserValues: unavailableAsync("listUserValues", "the Users page, which is a Draft"),
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
    decide: unavailableAsync("decide", "M4"),
    runCode: unavailable("runCode", "M5"),
    skills: {
      list: unavailableAsync("skills.list", "M7"),
      get: unavailableAsync("skills.get", "M7"),
      readFile: unavailableAsync("skills.readFile", "M7"),
      install: unavailableAsync("skills.install", "M7"),
      setEnabled: unavailableAsync("skills.setEnabled", "M7"),
      remove: unavailableAsync("skills.remove", "M7"),
    },
  }
}

export const makeThreadState = (state: StateContext): ThreadState => {
  const bridge = stateBridge(state)
  const { run, runPromise, origin, check } = bridge
  const threadStore = Context.get(state.services, ThreadStore)
  const threadId = state.thread.id
  // A read of the store finishes in the call that starts it, because no transaction spans an await. Each read gets
  // its own copy, so a tool or a hook that changes it changes nothing that a later read sees.
  const readHistory = (history: History) => () => {
    check()
    return Effect.runSyncWith(state.services)(history.read).rows.map(({ message }) => copyMessage(message))
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

    ...messageMethods(state, bridge),
    ...definitions(state, bridge),
    ...environment(state, bridge),
    ...toolMethods(state, bridge),
    ...unavailableMethods(check),
    runAgent: async (name) => {
      if (typeof name !== "string" || !name.length) return invalid("runAgent takes a non-empty agent name")
      return run(
        Effect.gen(function* () {
          const agent = yield* lookup("agent", name, state.from)
          if (!agent) return yield* new SetupError({ message: `No agent named ${name} is defined` })
          yield* state.control.runAgent(agent.qualifiedName, origin)
        }),
      )
    },
    stopSession: async (options = {}) => {
      check()
      if (!state.execution) return invalid("stopSession needs an active execution")
      if (
        !isRecord(options) ||
        Array.isArray(options) ||
        (["result", "notifyParent", "status"] as const).some(
          (key) => options[key] !== undefined && typeof options[key] !== "string",
        )
      )
        return invalid("stopSession takes an options object with optional string result, notifyParent and status")
      state.execution.run.stopSession()
    },
    getChildThread: (id) =>
      typeof id === "string" ? run(Effect.succeed(null)) : invalid("getChildThread takes a string reference id"),
    getParentThread: () => run(Effect.succeed(null)),
    setStatus: (status) => (typeof status === "string" ? run(Effect.void) : invalid("setStatus takes a string")),
    // The termination aborts the execution that this state may belong to, so the call itself is not bound to it.
    terminate: async () => {
      if (state.callback?.pastDeadline) throw new HandleExpired()
      terminated = await runPromise(state.control.terminate(origin))
    },
    // No client connects to a thread before the Thread Client API in M6, so an event has no receiver.
    emit: (event) => {
      check()
      if (typeof event !== "string") throw new InvalidArguments({ message: "emit takes a string event name" })
    },

    getValue: (key) =>
      typeof key === "string"
        ? (run(threadStore.getValue(threadId, key)) as Promise<never>)
        : invalid("getValue takes a string key"),
    setValue: (key, value) =>
      typeof key === "string"
        ? run(threadStore.setValue(threadId, key, value, origin))
        : invalid("setValue takes a string key"),
    user: () => run(Effect.succeed(null)),
    status: () => run(state.control.status),
  }
}
