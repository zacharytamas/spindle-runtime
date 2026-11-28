import { Effect } from "effect"
import type { HookScope, HookSet } from "./hooks.ts"
import type { ExecutionOptions, ThreadScope } from "./step.ts"
import { makeThreadState } from "./thread-state.ts"
import { scopeFor, type ToolContext, type ToolEnvironment } from "./tools.ts"

type Shared = Pick<ThreadScope, "thread" | "control" | "run" | "services" | "history" | "context" | "secrets">

// A hook and the tools it invokes share their environment and flow, but each callback owns its own lifetime.
export const makeToolScope = Effect.fnUntraced(function* <T extends ToolEnvironment>(
  thread: Shared,
  turn: T,
  set: HookSet,
  options: ExecutionOptions,
) {
  const scope = scopeFor(turn, undefined)
  const hooks: HookScope = {
    execution: thread.run,
    set,
    stateFor: (hook, call) => makeThreadState({ ...thread, execution, hooks, scope, from: hook.definition, call }),
  }
  const toolContext: ToolContext<T> = {
    execution: thread.run,
    secrets: thread.secrets,
    scope: yield* Effect.scope,
    toolTimeout: options.toolTimeout,
    turn,
    stateFor: (tool, entry, callback, writeCall) =>
      makeThreadState({
        ...thread,
        execution,
        hooks,
        scope: scopeFor(turn, entry),
        from: tool,
        caller: tool,
        callback,
        writeCall,
      }),
  }
  const execution = { history: thread.history, run: thread.run, toolContext }
  return { hooks, toolContext }
})
