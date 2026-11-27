import { expect, it } from "@effect/vitest"
import { defineHook, defineTool } from "@standardagents/spec"
import { Effect, Layer } from "effect"
import { SqliteLive } from "#platform"
import { ScriptedProvider } from "../../../conformance/src/ScriptedProvider.ts"
import { project } from "../../../conformance/src/scenarios/harness.ts"
import { layer as supervisorLayer } from "../../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage } from "../../src/execution/trigger.ts"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { layer } from "../../src/store/sqlite.ts"
import { registryOf } from "../spindle-driver.ts"

it.effect("gives create hooks the original unstorable draft and the replacement only if insertion fails", () =>
  Effect.gen(function* () {
    const attempts: Array<[string | null | undefined, string | null | undefined]> = []
    const repair = defineHook({
      id: "repair",
      hook: "before_create_message",
      execute: async (_state, message) => {
        if (message.role === "tool") {
          attempts.push([message.tool_call_id, message.tool_status])
          if (message.tool_call_id === "repairable") return { ...message, metadata: {} }
        }
        return message
      },
    })
    const tool = defineTool({
      description: "Returns unstorable diagnostic data",
      execute: async () => ({ status: "success" as const, result: "usable", error_data: { count: 1n } }),
    })
    const provider = new ScriptedProvider([
      { toolCalls: ["repairable", "fallback"].map((id) => ({ id, name: "diagnostic", arguments: {} })) },
      { text: "done" },
    ])
    const setup = project({ provider, tools: { diagnostic: tool }, hooks: [repair], prompt: { hooks: ["repair"] } })
    const stored = yield* Effect.gen(function* () {
      const thread = yield* createThread("assistant")
      yield* sendMessage(thread.id, "go")
      return (yield* (yield* MessageStore).history(thread.id)).rows
        .map((row) => row.message)
        .filter((message) => message.role === "tool")
    }).pipe(
      Effect.provide(
        Layer.merge(
          registryOf(setup),
          Layer.provideMerge(supervisorLayer(), layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))),
        ),
      ),
    )
    expect(attempts).toEqual([
      ["repairable", "success"],
      ["fallback", "success"],
      ["fallback", "error"],
    ])
    expect(stored.map((m) => [m.tool_call_id, m.tool_status])).toEqual([
      ["repairable", "success"],
      ["fallback", "error"],
    ])
    expect(stored[0]?.content).toBe("usable")
    expect(stored[1]?.content).toContain("a BigInt at $.error_data.count")
  }),
)

it.effect("keeps the conversion failure for a hidden tool call with a malformed name", () =>
  Effect.gen(function* () {
    const provider = new ScriptedProvider([{ text: "unreachable" }])
    const filter = defineHook({
      id: "hidden_call",
      hook: "filter_messages",
      execute: async (_state, messages) =>
        messages.map((message) => ({
          ...message,
          role: "user" as const,
          tool_calls: '[{"id":"hidden","function":{"na\\u006de":{"toString":0},"arguments":"{}"}}]',
        })),
    })
    const setup = project({ provider, hooks: [filter], prompt: { hooks: ["hidden_call"] } })
    const outcome = yield* Effect.gen(function* () {
      const thread = yield* createThread("assistant")
      return (yield* sendMessage(thread.id, "go")).outcome
    }).pipe(
      Effect.provide(
        Layer.merge(
          registryOf(setup),
          Layer.provideMerge(supervisorLayer(), layer.pipe(Layer.provide(SqliteLive({ filename: ":memory:" })))),
        ),
      ),
    )
    expect(outcome?.reason).toBe("fatal_error")
    expect(() => String({ toString: 0 })).toThrow(new TypeError(outcome?.error?.message))
    expect(provider.requests).toHaveLength(0)
  }),
)
