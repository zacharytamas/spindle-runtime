import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

// The holder identifies the process and the flow identifies one execution of the thread.
export default Effect.gen(function* () {
  const sql = yield* SqlClient

  yield* sql`
    CREATE TABLE holders (
      id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL
    ) STRICT`

  yield* sql`ALTER TABLE threads ADD COLUMN holder_id TEXT`
  yield* sql`ALTER TABLE threads ADD COLUMN flow_id TEXT`
  yield* sql`ALTER TABLE messages ADD COLUMN flow_id TEXT`
  yield* sql`ALTER TABLE messages ADD COLUMN caller_seq INTEGER`
  yield* sql`CREATE INDEX messages_flow_calls ON messages(flow_id) WHERE tool_calls IS NOT NULL`
  yield* sql`CREATE INDEX messages_results ON messages(caller_seq) WHERE caller_seq IS NOT NULL`
  yield* sql`CREATE INDEX threads_running ON threads (holder_id) WHERE run_state = 'running'`
})
