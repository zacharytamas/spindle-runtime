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

it.effect("a provider's request signal fires after an attempt that failed and not after one that completed", () =>
  Effect.gen(function* () {
    const scripted = new ScriptedProvider([
      { reject: new ProviderError("busy", "server_error", 503, 0) },
      { text: "ok" },
    ])
    const signals: Array<AbortSignal | undefined> = []
    const provider = {
      ...scripted,
      generate: scripted.generate.bind(scripted),
      stream: (request: Parameters<typeof scripted.stream>[0]) => {
        signals.push(request.signal)
        return scripted.stream(request)
      },
    }
    expect((yield* callModel(context(Effect.succeed(provider), new Execution("flow")), request))?.content).toBe("ok")
    yield* Effect.yieldNow
    expect(signals.map((signal) => signal?.aborted)).toEqual([true, false])
  }),
)

it.effect("aborts a failed request while its iterator is waiting for that signal to close", () =>
  Effect.gen(function* () {
    const scripted = new ScriptedProvider([])
    const release = Promise.withResolvers<void>()
    const events: string[] = []
    const provider = {
      ...scripted,
      generate: scripted.generate.bind(scripted),
      stream: async ({ signal }: Parameters<typeof scripted.stream>[0]) =>
        (async function* (): AsyncGenerator<ProviderStreamChunk> {
          signal?.addEventListener("abort", () => release.resolve(), { once: true })
          try {
            yield { type: "error", code: "invalid_request", error: "bad request" }
          } finally {
            events.push("return")
            await release.promise
            events.push("closed")
          }
        })(),
    }
    const call = context(Effect.succeed(provider), new Execution("flow"))
    try {
      yield* Effect.result(callModel(call, request))
      expect(call.calls.map((log) => log.error?.code)).toEqual(["invalid_request"])
      yield* Effect.yieldNow
      expect([...events]).toEqual(["return", "closed"])
    } finally {
      release.resolve()
    }
  }),
)
