import { Effect, type FileSystem, Layer, type Path, type Stdio, type Terminal } from "effect"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type * as BunPlatform from "./bun.ts"
import type * as NodePlatform from "./node.ts"

export interface Platform {
  readonly isolateDefinitionLoads: typeof import("./definition-load.ts").isolateDefinitionLoads
  readonly readDefinition: typeof import("./definition-load.ts").readDefinition
  readonly isMain: (meta: ImportMeta) => boolean
  readonly openChatTerminal: typeof import("./chat-terminal.ts").openChatTerminal
  readonly platformName: "node" | "bun"
  readonly PlatformLive: Layer.Layer<
    ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Stdio.Stdio | Terminal.Terminal
  >
  readonly SqliteLive: (options: { readonly filename: string }) => Layer.Layer<SqlClient, SqlError>
  readonly runMain: typeof import("./interrupts.ts").runMain
  readonly processAlive: (pid: number) => Effect.Effect<boolean>
  // The holder record names the process that runs an execution, so that a person can find it.
  readonly processId: number
  readonly Interrupts: typeof import("./interrupts.ts").Interrupts
}

// Loading node:sqlite prints a warning on Node 22. Load the driver only when a command opens a database.
export const lazySqlite =
  (load: () => Promise<{ SqliteClient: { layer: Platform["SqliteLive"] } }>): Platform["SqliteLive"] =>
  (options) =>
    Layer.unwrap(Effect.promise(load).pipe(Effect.map(({ SqliteClient }) => SqliteClient.layer(options))))

// Each adapter implements the contract, and the contract names every key the adapter exports.
type Implements<Contract extends Record<keyof Module, unknown>, Module extends Contract> = Module
export type Implementations = [Implements<Platform, typeof NodePlatform>, Implements<Platform, typeof BunPlatform>]
