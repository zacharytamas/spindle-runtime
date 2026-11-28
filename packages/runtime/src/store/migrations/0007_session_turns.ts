import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

export default Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE threads ADD COLUMN session_turns INTEGER NOT NULL DEFAULT 0`
  // A sender in another process may poll after the next run has already settled.
  yield* sql`ALTER TABLE waiting_senders ADD COLUMN settled_flow TEXT`
  yield* sql`ALTER TABLE waiting_senders ADD COLUMN settled_state TEXT`
  yield* sql`ALTER TABLE waiting_senders ADD COLUMN settled_reason TEXT`
  yield* sql`ALTER TABLE waiting_senders ADD COLUMN settled_since INTEGER`
  yield* sql`ALTER TABLE waiting_senders ADD COLUMN took_entry INTEGER NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE waiting_senders ADD COLUMN finished INTEGER NOT NULL DEFAULT 0`
  yield* sql`CREATE INDEX waiting_senders_pending ON waiting_senders(thread_id) WHERE finished = 0`
})
