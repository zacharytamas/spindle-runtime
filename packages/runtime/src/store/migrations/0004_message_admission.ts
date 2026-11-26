import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"

export default Effect.gen(function* () {
  const sql = yield* SqlClient
  yield* sql`ALTER TABLE messages ADD COLUMN admission_seq INTEGER`
})
