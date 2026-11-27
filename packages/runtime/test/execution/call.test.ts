import { expect, it } from "@effect/vitest"
import { ProviderError, type ProviderStreamChunk } from "@standardagents/spec"
import { Effect, Fiber, Latch } from "effect"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { type CallContext, callModel } from "../../src/execution/call.ts"
import { Execution } from "../../src/execution/Execution.ts"

const request = { model: "m", messages: [] }
const context = (provider: CallContext["provider"], run: Execution): CallContext => ({
  provider,
  step: 1,
  retries: 1,
  calls: [],
  pending: [],
  record: () => Effect.void,
  stopped: () => run.stopAtBoundary() !== undefined,
  waitForStop: run.waitForStop,
  toolChoice: undefined,
})

it.effect("a graceful stop wakes a scheduled retry without advancing the clock", () =>
  Effect.gen(function* () {
    const provider = new ScriptedProvider([{ reject: new ProviderError("busy", "rate_limit", 429, 60) }])
    const run = new Execution("flow")
    const waiting = yield* Latch.make()
    const call = context(Effect.succeed(provider), run)
    const fiber = yield* Effect.forkChild(
      callModel(
        {
          ...call,
          waitForStop: Effect.andThen(waiting.open, run.waitForStop),
        },
        request,
      ),
    )
    yield* waiting.await
    run.requestStop()
    expect(yield* Fiber.join(fiber)).toBeUndefined()
    expect(provider.requests).toHaveLength(1)
    expect(call.calls[0]?.error?.code).toBe("rate_limit")
  }),
)

it.effect("a slow or failing iterator finalizer cannot replace the provider failure or hold its retry", () =>
  Effect.gen(function* () {
    const release = Promise.withResolvers<void>()
    let closing = false
    const recovered = new ScriptedProvider([{ text: "recovered" }])
    const broken = {
      ...recovered,
      generate: recovered.generate.bind(recovered),
      stream: async () => ({
        [Symbol.asyncIterator]: () => ({
          next: async (): Promise<IteratorResult<ProviderStreamChunk>> => {
            throw new ProviderError("busy", "server_error", 503, 0)
          },
          return: async (): Promise<IteratorResult<ProviderStreamChunk>> => {
            closing = true
            await release.promise
            throw new Error("cleanup failed")
          },
        }),
      }),
    }
    const call = context(
      Effect.sync(() => (closing ? recovered : broken)),
      new Execution("flow"),
    )
    try {
      expect((yield* callModel(call, request))?.content).toBe("recovered")
      expect(call.calls.map((log) => log.error?.message)).toEqual(["busy", undefined])
    } finally {
      release.resolve()
    }
  }),
)
