import { BunServices } from "@effect/platform-bun"
import { lazySqlite, type Platform } from "./Platform.ts"

export * from "./shared.ts"

export const platformName: Platform["platformName"] = "bun"
export const PlatformLive = BunServices.layer
export const SqliteLive = lazySqlite(() => import("@effect/sql-sqlite-bun"))
