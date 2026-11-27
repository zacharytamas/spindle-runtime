import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

// A thread's revision goes up by one for each row of its messages that any connection inserts, updates, or deletes,
// in the transaction of that write, so a reader can tell whether its copy of the history is still current.
export default Effect.gen(function* () {
  const sql = yield* SqlClient

  yield* sql`ALTER TABLE threads ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`

  yield* sql`
    CREATE TRIGGER messages_insert_revision AFTER INSERT ON messages BEGIN
      UPDATE threads SET revision = revision + 1 WHERE id = NEW.thread_id;
    END`
  yield* sql`
    CREATE TRIGGER messages_update_revision AFTER UPDATE ON messages BEGIN
      UPDATE threads SET revision = revision + 1 WHERE id IN (OLD.thread_id, NEW.thread_id);
    END`
  yield* sql`
    CREATE TRIGGER messages_delete_revision AFTER DELETE ON messages BEGIN
      UPDATE threads SET revision = revision + 1 WHERE id = OLD.thread_id;
    END`
})
