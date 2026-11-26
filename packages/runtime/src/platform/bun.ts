import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import type { Platform } from "./Platform.ts"

export const platformName: Platform["platformName"] = "bun"

export const PlatformLive = BunServices.layer

export const SqliteLive: Platform["SqliteLive"] = (options) =>
  Layer.unwrap(
    Effect.promise(() => import("@effect/sql-sqlite-bun")).pipe(
      Effect.map(({ SqliteClient }) => SqliteClient.layer(options)),
    ),
  )

export const runMain = BunRuntime.runMain
