import type { AgentDefinition, ToolResult } from "@standardagents/spec"
import { Effect } from "effect"
import type { Registry } from "../registry/Registry.ts"
import { type Thread, ThreadStore } from "../store/ThreadStore.ts"
import { newSecrets } from "./env.ts"
import { agentHooks, type HookSet, hookScope, runHooks } from "./hooks.ts"
import { createMessage } from "./messages.ts"
import { type ExecutionOptions, learnSecrets, runExecution } from "./step.ts"
import { makeThreadState } from "./thread-state.ts"
import { lookup, prepareTurn, roleOf, sidesOf } from "./turn.ts"

// Hooks section 1.3 and Execution State section 1: an operation at rest has no active prompt, so the agent's hooks
// apply, and state.execution is null. A state that writes text for user code learns the turn's secrets first.
const atRest = (thread: Thread, options: { readonly learn: boolean; readonly secrets?: Set<string> }) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<Registry | ThreadStore>()
    const agent = yield* lookup<AgentDefinition>("agent", thread.agentId, undefined)
    const set: HookSet =
      agent === undefined
        ? { source: { kind: "agent", agentName: thread.agentId }, byPosition: new Map() }
        : yield* agentHooks(agent)
    const secrets = newSecrets(options.secrets)
    // A turn that cannot be prepared fails in its run with its own message. What it learned before that still counts.
    if (options.learn || set.byPosition.size > 0)
      yield* prepareTurn(thread.agentId).pipe(
        Effect.flatMap((turn) => learnSecrets(turn, secrets)),
        Effect.ignore,
      )
    const base = {
      thread,
      services,
      execution: undefined,
      scope: { agent: agent?.value.env, toolEntry: undefined, prompt: undefined },
      context: {},
      secrets,
      invoke: (name: string) =>
        Effect.succeed<ToolResult>({
          status: "error",
          error: `invokeTool(${name}) needs a calling tool and its uses list`,
        }),
    }
    const hooks = hookScope(set, (hook) => makeThreadState({ ...base, from: hook.definition, hooks }))
    return { hooks, secrets, state: makeThreadState({ ...base, from: agent?.definition, hooks }) }
  })

// The ThreadState an endpoint or another caller outside an execution sees.
export const stateAtRest = (threadId: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    return (yield* atRest(yield* store.getThread(threadId), { learn: true })).state
  })

// Hooks section 1.1: after_thread_created runs after the thread exists and before any message reaches it.
export const createThread = (agentId: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    const thread = yield* store.createThread({ agentId })
    const rest = yield* atRest(thread, { learn: false })
    yield* runHooks(rest.hooks, "after_thread_created", [], undefined)
    return thread
  })

// Runtime section 2: a message from the human side starts an execution of the prompt side. The message is written
// before the execution starts, at rest. M1-6 queues the message instead when the thread is already executing.
export const sendMessage = (threadId: string, content: string, options: ExecutionOptions = {}) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    const thread = yield* store.getThread(threadId)
    const { human } = yield* sidesOf(thread.agentId)
    const rest = yield* atRest(thread, {
      learn: false,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
    })
    const message = yield* createMessage(
      { threadId, hooks: rest.hooks, secrets: rest.secrets, history: undefined },
      { role: roleOf(human), content, status: "completed" },
      true,
    )
    if (options.observe !== undefined) yield* options.observe({ type: "message", message })
    return yield* runExecution(threadId, options)
  })
