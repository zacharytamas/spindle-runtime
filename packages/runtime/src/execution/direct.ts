import type { ToolResult } from "@standardagents/spec"
import { Effect } from "effect"
import type { Registry } from "../registry/Registry.ts"
import { FlowEnded } from "../store/model.ts"
import type { Stores } from "../store/sqlite.ts"
import { ThreadStore } from "../store/ThreadStore.ts"
import type { End, Execution } from "./Execution.ts"
import { newSecrets } from "./env.ts"
import { makeHistory } from "./history.ts"
import { agentHooks } from "./hooks.ts"
import { CLOSING } from "./run-status.ts"
import { type ExecutionOptions, prepareSides, type RunOutcome } from "./step.ts"
import type { DirectCall, ThreadControl } from "./thread-state.ts"
import { makeToolScope } from "./tool-scope.ts"
import { failed, invokeTool, notRun } from "./tools.ts"
import { loadAgent, SetupError } from "./turn.ts"

export function directExecution(call: DirectCall) {
  let result: ToolResult = notRun
  let entered = false
  const prepare = (threadId: string, run: Execution, control: ThreadControl, options: ExecutionOptions) => {
    const advance = Effect.gen(function* () {
      const thread = yield* (yield* ThreadStore).getThread(threadId)
      if (thread.terminated !== null || thread.status.state !== "running")
        return yield* new FlowEnded({
          threadId,
          flowId: run.flowId,
          why: thread.terminated !== null ? "terminated" : "superseded",
        })
      const agent = yield* loadAgent(thread.agentId)
      run.directSide = agent.value.sideA.human ? "b" : "a"
      const services = yield* Effect.context<Registry | Stores>()
      const base = {
        thread,
        control,
        run,
        services,
        history: makeHistory(threadId),
        context: {},
        secrets: newSecrets(options.secrets),
      }
      yield* Effect.ignore(prepareSides(agent, base.secrets))
      const { toolContext } = yield* makeToolScope(base, { kind: "agent", agent }, yield* agentHooks(agent), options)
      result = yield* invokeTool(
        toolContext,
        call.from,
        undefined,
        call.name,
        call.args,
        () => {
          entered = true
        },
        call.writeCall,
      )
      return run.stopAtBoundary() ?? { status: "idle" as const, reason: "direct_tool" }
    })
    const report = (end: End) =>
      Effect.succeed({
        threadId,
        flowId: run.flowId,
        steps: 0,
        trace: [],
        modelCalls: [],
        handlerCalls: [],
        ...end,
      })
    return Effect.succeed({ advance, report, stepCap: Infinity })
  }
  const finish = (run: Execution, outcome: RunOutcome) => {
    if (outcome.reason === "execution_lost") return Effect.succeed(failed(CLOSING.lost))
    if (outcome.status === "failed")
      return Effect.fail(new SetupError({ message: outcome.error?.message ?? outcome.reason }))
    if (run.displaced === "terminated") return Effect.succeed(failed(CLOSING.terminated))
    if (run.signal.aborted) return Effect.succeed(entered ? failed(CLOSING.aborted) : notRun)
    return Effect.succeed(result)
  }
  return { prepare, finish }
}
