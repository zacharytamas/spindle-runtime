import { Effect, type FileSystem, Layer, type Path, type Stdio, type Terminal } from "effect"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import type { makeRunMain } from "effect/Runtime"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type * as BunPlatform from "./bun.ts"
import type * as NodePlatform from "./node.ts"

export interface Platform {
  readonly openChatTerminal: typeof import("./chat-terminal.ts").openChatTerminal
  readonly platformName: "node" | "bun"
  readonly PlatformLive: Layer.Layer<
    ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Stdio.Stdio | Terminal.Terminal
  >
  readonly SqliteLive: (options: { readonly filename: string }) => Layer.Layer<SqlClient, SqlError>
  readonly runMain: ReturnType<typeof makeRunMain>
  readonly processAlive: (pid: number) => Effect.Effect<boolean>
  // The holder record names the process that runs an execution, so that a person can find it.
  readonly processId: number
  // Registers the handler that gets the next keyboard interrupt instead of the main fiber, and returns its removal.
  readonly onInterrupt: (handler: () => void) => () => void
}

// Loading node:sqlite prints a warning on Node 22. Load the driver only when a command opens a database.
export const lazySqlite =
  (load: () => Promise<{ SqliteClient: { layer: Platform["SqliteLive"] } }>): Platform["SqliteLive"] =>
  (options) =>
    Layer.unwrap(Effect.promise(load).pipe(Effect.map(({ SqliteClient }) => SqliteClient.layer(options))))

// Each adapter implements the contract, and the contract names every key the adapter exports.
type Implements<Contract extends Record<keyof Module, unknown>, Module extends Contract> = Module
export type Implementations = [Implements<Platform, typeof NodePlatform>, Implements<Platform, typeof BunPlatform>]
