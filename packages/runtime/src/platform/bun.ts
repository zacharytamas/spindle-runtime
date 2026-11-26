import { BunRuntime, BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import type { Layer } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"

export const platformName = "bun"

export const PlatformLive = BunServices.layer

export const SqliteLive = (options: { readonly filename: string }): Layer.Layer<SqlClient, SqlError> =>
  SqliteClient.layer(options)

export const runMain = BunRuntime.runMain
