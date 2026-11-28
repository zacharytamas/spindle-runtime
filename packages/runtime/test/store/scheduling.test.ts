import { expect, it } from "@effect/vitest"
import { Effect, Scheduler } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as Statement from "effect/sql/Statement"
import { MessageStore } from "../../src/store/MessageStore.ts"
import { external } from "../../src/store/model.ts"
import { RunStore } from "../../src/store/RunStore.ts"
import { ThreadStore } from "../../src/store/ThreadStore.ts"
import { claim, inMemory } from "./contract-fixtures.ts"

it.effect("every store operation prevents scheduler yields while using the connection", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadStore
    const messages = yield* MessageStore
    const runs = yield* RunStore
    const sql = yield* SqlClient
    const { id } = yield* threads.createThread({ agentId: "assistant" })
    type Calls<Service> = Record<keyof Service, Effect.Effect<unknown, unknown>>
    const operations = [
      {
        transaction: threads.transaction(sql`SELECT 1`),
        createThread: threads.createThread({ agentId: "assistant" }),
        getThread: threads.getThread(id),
        setValue: threads.setValue(id, "key", 1, external),
        getValue: threads.getValue(id, "key"),
      } satisfies Calls<typeof threads>,
      {
        insertMessage: messages.insertMessage(id, { id: "m", role: "user", created_at: 1 }, external),
        updateMessage: messages.updateMessage(id, "m", { content: "edited" }, external),
        getMessage: messages.getMessage(id, "m"),
        getMessages: messages.getMessages(id),
        latestMessageSeq: messages.latestMessageSeq(id),
        messagesAfter: messages.messagesAfter(id, 0),
        history: messages.history(id),
        revision: messages.revision(id),
        messageIdTaken: messages.messageIdTaken("m"),
        deleteMessage: messages.deleteMessage(id, "m", external),
      } satisfies Calls<typeof messages>,
      {
        acquireHolder: Effect.scoped(runs.acquireHolder({ id: claim.holder, pid: 0 })),
        admit: runs.admit(id, { kind: "message", message: { role: "user", content: "go" } }, claim, external),
        completeTurn: runs.completeTurn(id, claim.flowId),
        failedDeliveries: runs.failedDeliveries(id),
        discardFailed: runs.discardFailed(id, "2"),
        releaseSender: runs.releaseSender(1, claim.holder),
        queueDisposition: runs.queueDisposition(id, 1),
        isQueued: runs.isQueued(id, 1),
        nextQueued: runs.nextQueued(id, claim),
        queueLength: runs.queueLength(id),
        holderOf: runs.holderOf(id),
        owned: runs.owned(claim.holder),
        settle: runs.settle(id, claim, { state: "idle", reason: "aborted" }, { continueIfQueued: false, closing: "" }),
        claim: runs.claim(id, claim),
        pruneHolders: runs.pruneHolders(),
        recoverLost: runs.recoverLost(id),
        recoverThread: runs.recoverThread(id, true),
        terminate: runs.terminate(id, external),
      } satisfies Calls<typeof runs>,
    ]

    for (const [name, operation] of operations.flatMap((service) => Object.entries(service))) {
      const guarded: boolean[] = []
      const observe: Statement.Transformer = (statement, _sql, fiber) => {
        guarded.push(fiber.getRef(Scheduler.PreventSchedulerYield))
        return Effect.succeed(statement)
      }
      const call: Effect.Effect<unknown, unknown> = operation
      yield* call.pipe(
        Effect.provideService(Statement.CurrentTransformer, observe),
        Effect.provideService(Scheduler.PreventSchedulerYield, false),
      )
      expect(guarded.length, name).toBeGreaterThan(0)
      expect(guarded, name).not.toContain(false)
    }
  }).pipe(Effect.provide(inMemory)),
)
