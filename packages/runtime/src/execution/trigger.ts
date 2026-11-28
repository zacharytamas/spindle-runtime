import { Effect } from "effect"
import type { Registry } from "../registry/Registry.ts"
import type { Thread } from "../store/model.ts"
import type { Stores } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import { newSecrets } from "./env.ts"
import { agentHooks, type HookScope, type HookSet, observeHooks } from "./hooks.ts"
import { type ExecutionOptions, prepareSides } from "./step.ts"
import { ThreadSupervisor } from "./ThreadSupervisor.ts"
import { makeThreadState } from "./thread-state.ts"
import { lookup } from "./turn.ts"

// Hooks section 1.3 and Execution State section 1: an operation at rest has no active prompt, so the agent's hooks
// apply, and state.execution is null. A state that writes text for user code learns the turn's secrets first.
const atRest = (thread: Thread, options: { readonly learn: boolean; readonly secrets?: Set<string> }) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<Registry | Stores>()
    const supervisor = yield* ThreadSupervisor
    const agent = yield* lookup("agent", thread.agentId, undefined)
    const set: HookSet =
      agent === undefined
        ? { source: { kind: "agent", agentName: thread.agentId }, byPosition: new Map() }
        : yield* agentHooks(agent)
    const secrets = newSecrets(options.secrets)
    // A turn that cannot be prepared fails in its run with its own message. What it learned before that still counts.
    if (agent && (options.learn || set.byPosition.size > 0)) yield* Effect.ignore(prepareSides(agent, secrets))
    const base = {
      thread,
      services,
      execution: undefined,
      scope: { agent: agent?.value.env, toolEntry: undefined, prompt: undefined },
      context: {},
      secrets,
      control: supervisor.control(thread.id),
    }
    const hooks: HookScope = {
      set,
      stateFor: (hook, call) => makeThreadState({ ...base, from: hook.definition, hooks, call }),
    }
    return { hooks, secrets, state: makeThreadState({ ...base, from: agent, hooks }) }
  })

// The ThreadState an endpoint or another caller outside an execution sees.
export const stateAtRest = (threadId: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    return (yield* atRest(yield* store.getThread(threadId), { learn: true })).state
  })

// Hooks section 1.1: after_thread_created runs after the thread exists and before any message reaches it.
export const createThread = (
  agentId: string,
  secrets?: Set<string>,
  reportCreated?: (id: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    return yield* Effect.acquireUseRelease(
      store.createThread({ agentId }),
      (thread) =>
        Effect.gen(function* () {
          const rest = yield* atRest(thread, { learn: false, ...(secrets ? { secrets } : {}) })
          yield* observeHooks(rest.hooks, "after_thread_created", [])
          return thread
        }),
      (thread) => reportCreated?.(thread.id) ?? Effect.void,
    )
  })

// Runtime section 2: a message from the human side starts an execution of the prompt side, or enters the running one
// before its next model call. Either way it goes through the queue, so it is durable when it is accepted, and the
// execution stores it with the agent's hooks at its next drain.
export const sendMessage = (threadId: string, content: string, options: ExecutionOptions = {}) =>
  Effect.gen(function* () {
    const supervisor = yield* ThreadSupervisor
    return yield* supervisor.send(threadId, content, options)
  })
