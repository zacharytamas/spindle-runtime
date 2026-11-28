import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

export default Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`CREATE TABLE queue_new (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads (id),
    kind TEXT NOT NULL CHECK (kind IN ('message', 'tool', 'agent')),
    payload TEXT NOT NULL,
    queued_at INTEGER NOT NULL,
    disposition TEXT NOT NULL DEFAULT 'pending' CHECK (disposition IN ('pending', 'failed_delivery'))
  ) STRICT`
  yield* sql`INSERT INTO queue_new SELECT seq, thread_id, kind, payload, queued_at, disposition FROM queue`
  // Deleted entries can still have waiting senders. Never reuse their sequence numbers.
  yield* sql`UPDATE sqlite_sequence SET seq = max(seq, coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'queue'), 0))
    WHERE name = 'queue_new'`
  yield* sql`DROP TABLE queue`
  yield* sql`ALTER TABLE queue_new RENAME TO queue`
  yield* sql`CREATE INDEX queue_by_thread ON queue (thread_id, seq)`
})
