import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

export default Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE threads ADD COLUMN side_a_delivered_seq INTEGER NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE threads ADD COLUMN side_b_delivered_seq INTEGER NOT NULL DEFAULT 0`
})
