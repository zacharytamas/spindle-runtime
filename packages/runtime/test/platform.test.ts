import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SqlClient } from "effect/sql/SqlClient"
import { vi } from "vitest"
import { PlatformLive, platformName, SqliteLive } from "#platform"

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

  it.live("recognizes a symlinked entry when Node preserves symlinks and import.meta.main is absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const dir = yield* fs.makeTempDirectoryScoped()
      const shared = new URL("../src/platform/shared.ts", import.meta.url).href
      yield* fs.writeFileString(
        `${dir}/entry.mjs`,
        `import { isMain } from ${JSON.stringify(shared)}
console.log(isMain({ url: import.meta.url }), isMain({ url: ${JSON.stringify(shared)} }), isMain({ url: import.meta.url + "?copy" }))`,
      )
      const link = `${dir}/link.mjs`
      yield* fs.symlink(`${dir}/entry.mjs`, link)
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      for (const flag of ["--preserve-symlinks", "--preserve-symlinks-main"]) {
        const output = yield* spawner.string(ChildProcess.make("node", [flag, link]))
        expect(output.trim(), flag).toBe("true false false")
      }
    }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
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
