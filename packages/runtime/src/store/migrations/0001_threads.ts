import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

export default Effect.gen(function* () {
  const sql = yield* SqlClient

  yield* sql`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      parent_id TEXT REFERENCES threads (id),
      arguments TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      terminated_at INTEGER,
      run_state TEXT NOT NULL DEFAULT 'idle' CHECK (run_state IN ('idle', 'running', 'failed')),
      run_reason TEXT CHECK (run_state <> 'running' OR run_reason IS NULL),
      run_since INTEGER NOT NULL DEFAULT 0
    ) STRICT`

  yield* sql`
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      thread_id TEXT NOT NULL REFERENCES threads (id),
      role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT,
      name TEXT,
      tool_calls TEXT,
      tool_call_id TEXT,
      tool_status TEXT CHECK (tool_status IN ('success', 'error')),
      status TEXT CHECK (status IN ('pending', 'completed', 'failed')),
      attachments TEXT,
      reasoning_content TEXT,
      reasoning_details TEXT,
      prompt TEXT,
      created_at INTEGER NOT NULL,
      parent_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      silent INTEGER NOT NULL DEFAULT 0 CHECK (silent IN (0, 1)),
      metadata TEXT NOT NULL DEFAULT '{}'
    ) STRICT`
  yield* sql`CREATE INDEX messages_by_thread ON messages (thread_id, seq)`

  yield* sql`
    CREATE TABLE queue (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL REFERENCES threads (id),
      kind TEXT NOT NULL CHECK (kind IN ('message', 'tool')),
      payload TEXT NOT NULL,
      queued_at INTEGER NOT NULL
    ) STRICT`
  yield* sql`CREATE INDEX queue_by_thread ON queue (thread_id, seq)`

  yield* sql`
    CREATE TABLE kv (
      thread_id TEXT NOT NULL REFERENCES threads (id),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (thread_id, key)
    ) STRICT, WITHOUT ROWID`
})
