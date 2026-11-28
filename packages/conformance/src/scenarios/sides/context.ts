import { defineHook, defineTool, type ThreadState } from "@standardagents/spec"
import { expect } from "vitest"
import { ScriptedProvider } from "../../ScriptedProvider.ts"
import { ok, type Scenario } from "../harness.ts"
import { usingDual } from "./fixtures.ts"

const recordContext = (
  refs: Array<Record<string, unknown>>,
  argsSeen: Array<Record<string, unknown>>,
  state: ThreadState,
  label: string,
) => {
  refs.push(state.context)
  argsSeen.push(structuredClone(state.arguments))
  const trail = (state.context.trail as Array<string> | undefined) ?? []
  trail.push(label)
  state.context.trail = trail
}

export const T12: Scenario = {
  name: "T12 (rules 6, 7) shares one mutable state.context across delivery hooks, side A, side B, and nested tools, never leaks into arguments, and resets next run",
  requirements: ["2ea40632", "c487ef3f", "357c07d0", "c2a80b35", "d4e23481"],
  run: async (driver) => {
    const refs: Array<Record<string, unknown>> = []
    const argsSeen: Array<Record<string, unknown>> = []
    const observed: Array<unknown> = []
    const hooks = [
      defineHook({
        hook: "before_create_message",
        id: "delivery_before",
        execute: async (state, message) => {
          if (message.role === "user" && message.content?.startsWith("run ")) {
            observed.push(["delivery_before", Object.keys(state.context)])
            state.context.fromDelivery = message.content
            recordContext(refs, argsSeen, state, `delivery_before:${message.content}`)
          }
          return message
        },
      }),
      defineHook({
        hook: "after_create_message",
        id: "delivery_after",
        execute: async (state, message) => {
          if (message.role === "user" && message.content?.startsWith("run "))
            recordContext(refs, argsSeen, state, `delivery_after:${String(state.context.fromDelivery)}`)
        },
      }),
      defineHook({
        hook: "after_system_message",
        id: "side_a_sys",
        execute: async (state, system) => {
          if (state.execution?.stepCount === 0) recordContext(refs, argsSeen, state, "side_a_sys")
          return system
        },
      }),
      defineHook({
        hook: "filter_messages",
        id: "side_b_filter",
        execute: async (state, messages) => {
          recordContext(refs, argsSeen, state, `side_b_filter:${String(state.context.fromInner)}`)
          if (state.context.fromDelivery === "run 2")
            observed.push(["side_b_filter:run2", state.context.fromDelivery, state.context.fromInner])
          return messages
        },
      }),
    ]
    const tools = {
      a_inner: defineTool({
        description: "Nested tool",
        execute: async (state: ThreadState) => {
          state.context.fromInner = "nested"
          recordContext(refs, argsSeen, state, "a_inner")
          return ok("inner")
        },
      }),
      a_outer: defineTool({
        description: "Outer tool invoking nested tool",
        uses: ["a_inner"] as Array<string>,
        execute: async (state: ThreadState) => {
          recordContext(refs, argsSeen, state, "a_outer:before")
          await state.invokeTool("a_inner", {})
          recordContext(refs, argsSeen, state, `a_outer:after:${String(state.context.fromInner)}`)
          return ok("outer")
        },
      }),
      b_tool: defineTool({
        description: "Side B tool reading shared context",
        execute: async (state: ThreadState) => {
          recordContext(refs, argsSeen, state, "b_tool")
          observed.push([
            "b_tool",
            state.context.fromDelivery,
            state.context.fromInner,
            [...(state.context.trail as Array<string>)],
          ])
          return ok("reviewed")
        },
      }),
    }
    const providerA = new ScriptedProvider([
      { toolCalls: [{ id: "ca1", name: "a_outer", arguments: {} }] },
      { text: "A1" },
      { text: "A2" },
    ])
    const providerB = new ScriptedProvider([
      { toolCalls: [{ id: "cb1", name: "b_tool", arguments: {} }] },
      { text: "B1" },
      { text: "B2" },
    ])
    await usingDual(
      driver,
      {
        providerA,
        providerB,
        tools,
        hooks,
        agent: { hooks: ["delivery_before", "delivery_after"], maxSessionTurns: 2 },
        promptA: { hooks: ["side_a_sys"], tools: ["a_outer"] },
        promptB: { hooks: ["side_b_filter"], tools: ["b_tool"] },
      },
      async (session, thread) => {
        expect(await session.send(thread, "run 1")).toMatchObject({ status: "idle", reason: "max_session_turns" })
        const run1Count = refs.length
        const run1Ref = refs[0]
        expect(run1Count).toBeGreaterThanOrEqual(7)
        expect(refs.every((ref) => ref === run1Ref)).toBe(true)
        const rest = await session.state(thread)
        expect([rest.context, rest.arguments]).toEqual([{}, {}])
        expect(await session.send(thread, "run 2")).toMatchObject({ status: "idle", reason: "max_session_turns" })
        const run2Refs = refs.slice(run1Count)
        expect(run2Refs.length).toBeGreaterThanOrEqual(3)
        expect(run2Refs.every((ref) => ref === run2Refs[0] && ref !== run1Ref)).toBe(true)
      },
    )
    expect(observed).toEqual([
      ["delivery_before", []],
      [
        "b_tool",
        "run 1",
        "nested",
        [
          "delivery_before:run 1",
          "delivery_after:run 1",
          "side_a_sys",
          "a_outer:before",
          "a_inner",
          "a_outer:after:nested",
          "side_b_filter:nested",
          "b_tool",
        ],
      ],
      ["delivery_before", []],
      ["side_b_filter:run2", "run 2", undefined],
    ])
    expect(argsSeen.every((args) => Object.keys(args).length === 0)).toBe(true)
  },
}
