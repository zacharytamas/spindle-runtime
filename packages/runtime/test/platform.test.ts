import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { vi } from "vitest"
import { platformName, SqliteLive } from "#platform"

const sqlitePackagesLoaded = vi.hoisted((): Array<string> => [])
vi.mock("@effect/sql-sqlite-node", (importOriginal) => {
  sqlitePackagesLoaded.push("node")
  return importOriginal()
})
vi.mock("@effect/sql-sqlite-bun", (importOriginal) => {
  sqlitePackagesLoaded.push("bun")
  return importOriginal()
})
const loadedAtImport = [...sqlitePackagesLoaded]

describe("platform", () => {
  it("resolves #platform to the module for the running runtime", ({ task }) => {
    expect(platformName).toBe(task.file.projectName)
  })

  it.effect("loads the SQLite package only when SqliteLive builds", () =>
    Effect.gen(function* () {
      expect(loadedAtImport).toEqual([])
      yield* Layer.build(SqliteLive({ filename: ":memory:" }))
      expect(sqlitePackagesLoaded).toEqual([platformName])
    }),
  )

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
