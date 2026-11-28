import { Context, Effect, Layer } from "effect"
import * as Migrator from "effect/sql/Migrator"
import { SqlClient } from "effect/sql/SqlClient"
import { database } from "./database.ts"
import { MessageStore, makeMessageStore } from "./MessageStore.ts"
import threads from "./migrations/0001_threads.ts"
import revisions from "./migrations/0002_revision.ts"
import claims from "./migrations/0003_claims.ts"
import admission from "./migrations/0004_message_admission.ts"
import resultPrompt from "./migrations/0005_result_prompt.ts"
import waitingSenders from "./migrations/0006_waiting_senders.ts"
import sessionTurns from "./migrations/0007_session_turns.ts"
import handlerDelivery from "./migrations/0008_handler_delivery.ts"
import queueAgent from "./migrations/0009_queue_agent.ts"
import { makeRunStore, RunStore } from "./RunStore.ts"
import { makeThreadStore, ThreadStore } from "./ThreadStore.ts"

const migrate = Migrator.make({})({
  loader: Migrator.fromRecord({
    "0001_threads": threads,
    "0002_revision": revisions,
    "0003_claims": claims,
    "0004_message_admission": admission,
    "0005_result_prompt": resultPrompt,
    "0006_waiting_senders": waitingSenders,
    "0007_session_turns": sessionTurns,
    "0008_handler_delivery": handlerDelivery,
    "0009_queue_agent": queueAgent,
  }),
})

export type Stores = ThreadStore | MessageStore | RunStore

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const sql = yield* SqlClient
    // Both pragmas are per connection, and both SQLite clients hold one connection.
    yield* sql`PRAGMA foreign_keys = ON`
    yield* sql`PRAGMA synchronous = FULL`
    yield* migrate

    const db = database(sql)
    return Context.make(ThreadStore, makeThreadStore(db)).pipe(
      Context.add(MessageStore, makeMessageStore(db)),
      Context.add(RunStore, makeRunStore(db)),
    )
  }),
)
