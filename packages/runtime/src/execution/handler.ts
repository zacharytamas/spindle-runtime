import type { Message } from "@standardagents/spec"
import { Effect, Result } from "effect"
import { describeCause } from "../registry/load-error.ts"
import { RunStore } from "../store/RunStore.ts"
import { Callback } from "./callback.ts"
import { deliverQueued, queueRecipient, runQueuedTool } from "./drain.ts"
import type { End } from "./Execution.ts"
import { copyMessage } from "./history.ts"
import type { ThreadScope, ToolScope } from "./step.ts"
import { makeThreadState } from "./thread-state.ts"
import { invokeTool, scopeFor } from "./tools.ts"
import { type HandlerSideValue, otherSide, type Side, type SideValue } from "./turn.ts"

interface Delivery {
  readonly message: Message
  readonly seq: number
}

const replaceIn = (list: Array<Delivery>, message: Message) => {
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]
    if (entry && entry.message.id === message.id) list[i] = { seq: entry.seq, message: copyMessage(message) }
  }
}

const removeFrom = (list: Array<Delivery>, messageId: string) => {
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.message.id === messageId) list.splice(i, 1)
  }
}

// Only writes made during this turn can cause a handoff. Keep the committed copy
// before injectMessage gives user code a mutable result, and publish it only on success.
export class HandlerDeliveries {
  readonly inbox: Record<Side, Array<Delivery>> = { a: [], b: [] }
  #outgoing: Array<Delivery> = []
  #role: Message["role"] | undefined

  begin(role: Message["role"] | undefined) {
    this.#role = role
    this.#outgoing = []
  }
  inserted(row: Delivery) {
    if (row.message.role === this.#role) this.#outgoing.push({ seq: row.seq, message: copyMessage(row.message) })
  }
  updated(message: Message) {
    replaceIn(this.#outgoing, message)
    replaceIn(this.inbox.a, message)
    replaceIn(this.inbox.b, message)
  }
  deleted(messageId: string) {
    removeFrom(this.#outgoing, messageId)
    removeFrom(this.inbox.a, messageId)
    removeFrom(this.inbox.b, messageId)
  }
  take(side: Side) {
    return this.inbox[side].shift()
  }
  finish(peer: SideValue, success: boolean) {
    const batch = this.#outgoing
    this.begin(undefined)
    if (success && peer.kind === "handler") this.inbox[peer.side].push(...batch)
    return batch
  }
}

export interface HandlerCall {
  readonly side: Side
  readonly handler: string
  readonly messageId: string
  readonly status: "success" | "failed"
  readonly error?: { readonly origin: "runtime"; readonly message: string }
}

const nextPeerMessage = Effect.fnUntraced(function* (thread: ThreadScope, side: Side) {
  const store = yield* RunStore
  for (let row = thread.deliveries.take(side); row !== undefined; row = thread.deliveries.take(side)) {
    const current = yield* store.advanceDelivery(thread.thread.id, thread.run.flowId, side, row.seq, row.message.id)
    if (current !== null) return current
  }
})

const receive = Effect.fnUntraced(function* (scope: ToolScope<HandlerSideValue>, thread: ThreadScope, forced: boolean) {
  const { turn } = scope
  const peerMessage = yield* nextPeerMessage(thread, turn.side)
  if (peerMessage) return peerMessage
  const store = yield* RunStore
  while (!thread.run.stopAtBoundary()) {
    const entry = yield* store.nextQueued(thread.thread.id, thread.run)
    if (!entry || queueRecipient(thread.sides, entry).side !== turn.side) return
    if (entry.kind === "message" && entry.message.role !== turn.role) {
      const delivered = yield* deliverQueued(thread, entry, turn.side)
      if (delivered) return delivered
      continue
    }
    if (forced) return
    if (entry.kind === "tool") yield* runQueuedTool(scope, thread, entry)
    else yield* deliverQueued(thread, entry)
  }
})

const executeHandler = Effect.fnUntraced(function* (
  scope: ToolScope<HandlerSideValue>,
  thread: ThreadScope,
  message: Message,
) {
  const { turn, toolContext } = scope
  const { handler } = turn
  const { run, history } = thread
  const callback = new Callback()
  const state = makeThreadState({
    ...thread,
    execution: { history, run },
    hooks: scope.write.hooks,
    callback,
    scope: scopeFor(turn, undefined),
    from: handler,
    invoke: (name, args, onExecute) =>
      invokeTool(toolContext, handler, undefined, name, args, onExecute).pipe(Effect.provideContext(thread.services)),
  })
  thread.deliveries.begin(turn.role)
  const result = yield* Effect.result(
    Effect.tryPromise({
      try: () =>
        run.call(callback, `handler ${handler.qualifiedName}`, () =>
          handler.value.execute(state, copyMessage(message)),
        ),
      catch: (cause) => ({ origin: "runtime" as const, message: thread.redact(describeCause(cause)) }),
    }),
  )
  const error = Result.isFailure(result) ? result.failure : undefined
  thread.handlerCalls.push({
    side: turn.side,
    handler: handler.qualifiedName,
    messageId: message.id,
    status: error ? "failed" : "success",
    ...(error && { error }),
  })
  if (error) yield* Effect.logWarning(thread.redact(`Handler ${handler.qualifiedName} failed: ${error.message}`))
  return error
})

function handlerEnd(thread: ThreadScope, forced: boolean): End {
  const error = thread.handlerCalls.at(-1)?.error
  return error && !forced
    ? { status: "failed", reason: "handler_error", error, continueIfQueued: true }
    : { status: "idle", reason: "handler_idle", continueIfQueued: !forced }
}

function handlerHandoff(
  thread: ThreadScope,
  turn: HandlerSideValue,
  peer: SideValue,
  success: boolean,
  wrote: boolean,
) {
  const { run, sides, deliveries } = thread
  const target = run.turns.takeTarget()
  if (success && target) {
    if (sides[target].kind === "human")
      return { status: "idle", reason: "forced_human_turn", continueIfQueued: true } satisfies End
    return { next: sides[target], reason: "force_turn" }
  }
  if (success && wrote && peer.kind !== "human") return { next: peer, reason: "handler_reply" }
  const remaining = !deliveries.inbox[turn.side].length && deliveries.inbox[peer.side].length ? peer : turn
  return { next: remaining, reason: "handler_delivery" }
}

export const handlerTurn = Effect.fnUntraced(function* (
  scope: ToolScope<HandlerSideValue>,
  thread: ThreadScope,
  forced: boolean,
  turnCap: number,
) {
  const { run, sides, deliveries } = thread
  const { turn } = scope
  const peer = sides[otherSide(turn.side)]
  if (run.stopAtBoundary()) return run.abortEnd
  const message = yield* receive(scope, thread, forced)
  if (run.stopAtBoundary()) return run.abortEnd
  if (!message) return handlerEnd(thread, forced)
  const error = yield* executeHandler(scope, thread, message)
  const writes = deliveries.finish(peer, !error)
  for (const { message } of writes)
    yield* thread.observe({ type: "message", message: copyMessage(message), handlerOutput: true })
  if (run.stopAtBoundary()) return run.abortEnd
  const end = yield* run.completeTurn(thread.thread.id, undefined, sides.agent.value.maxSessionTurns, turnCap)
  if (end) return end
  return handlerHandoff(thread, turn, peer, !error, writes.length > 0)
})
