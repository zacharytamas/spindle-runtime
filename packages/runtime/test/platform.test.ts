import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { platformName, SqliteLive } from "#platform"

describe("platform", () => {
  it("resolves #platform to the module for the running runtime", ({ task }) => {
    expect(platformName).toBe(task.file.projectName)
  })

  it.effect("reads back a row from an in-memory SQLite database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient
      yield* sql`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`
      yield* sql`INSERT INTO notes ${sql.insert({ id: 1, body: "hello" })}`
      const rows = yield* sql`SELECT id, body FROM notes`
      expect(rows).toEqual([{ id: 1, body: "hello" }])
    }).pipe(Effect.provide(SqliteLive({ filename: ":memory:" }))),
  )
})
