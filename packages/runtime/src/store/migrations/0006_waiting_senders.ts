import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

// A discard can remove a failed entry before the sending process sees the result.
export default Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE waiting_senders (
    seq INTEGER PRIMARY KEY,
    thread_id TEXT NOT NULL,
    holder_id TEXT NOT NULL REFERENCES holders(id) ON DELETE CASCADE,
    failed INTEGER NOT NULL DEFAULT 0
  ) STRICT`
  yield* sql`CREATE INDEX waiting_senders_holder ON waiting_senders(holder_id)`
})
