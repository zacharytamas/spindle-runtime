import { NodeServices } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import type { Platform } from "./Platform.ts"

export { onInterrupt, runMain } from "./interrupts.ts"

export const platformName: Platform["platformName"] = "node"

export const PlatformLive = NodeServices.layer

export const processId: Platform["processId"] = process.pid

// Loading node:sqlite prints an ExperimentalWarning on Node 22, so only commands that open a database load it.
export const SqliteLive: Platform["SqliteLive"] = (options) =>
  Layer.unwrap(
    Effect.promise(() => import("@effect/sql-sqlite-node")).pipe(
      Effect.map(({ SqliteClient }) => SqliteClient.layer(options)),
    ),
  )

export { processAlive } from "./process-alive.ts"
