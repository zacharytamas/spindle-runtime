import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

// Runtime section 11 allows one execution per thread across every process that opens the file. A running thread
// names the holder that runs it and the flow of that execution. A holder is one process: it renews its lease while
// it lives, so another process can tell a live holder from a dead one. claim_seq is the last message seq when the run
// started, so recovery knows which calls belong to the lost execution.
export default Effect.gen(function* () {
  const sql = yield* SqlClient

  yield* sql`
    CREATE TABLE holders (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      beat_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT`

  yield* sql`ALTER TABLE threads ADD COLUMN holder_id TEXT`
  yield* sql`ALTER TABLE threads ADD COLUMN flow_id TEXT`
  yield* sql`ALTER TABLE threads ADD COLUMN claim_seq INTEGER`
  yield* sql`CREATE INDEX threads_running ON threads (holder_id) WHERE run_state = 'running'`
})
