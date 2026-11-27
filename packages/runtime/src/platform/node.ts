import { NodeServices } from "@effect/platform-node"
import { lazySqlite, type Platform } from "./Platform.ts"

export * from "./shared.ts"

export const platformName: Platform["platformName"] = "node"
export const PlatformLive = NodeServices.layer
export const SqliteLive = lazySqlite(() => import("@effect/sql-sqlite-node"))
