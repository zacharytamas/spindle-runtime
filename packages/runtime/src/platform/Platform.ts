import type { FileSystem, Layer, Path, Stdio, Terminal } from "effect"
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import type { makeRunMain } from "effect/Runtime"
import type { SqlClient } from "effect/sql/SqlClient"
import type { SqlError } from "effect/sql/SqlError"
import type * as BunPlatform from "./bun.ts"
import type * as NodePlatform from "./node.ts"

export interface Platform {
  readonly platformName: "node" | "bun"
  readonly PlatformLive: Layer.Layer<
    ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Stdio.Stdio | Terminal.Terminal
  >
  readonly SqliteLive: (options: { readonly filename: string }) => Layer.Layer<SqlClient, SqlError>
  readonly runMain: ReturnType<typeof makeRunMain>
  // The holder record names the process that runs an execution, so that a person can find it.
  readonly processId: number
  // Registers the handler that gets the next keyboard interrupt instead of the main fiber, and returns its removal.
  readonly onInterrupt: (handler: () => void) => () => void
}

// tsc resolves #platform to node.ts only, so this is what holds bun.ts to the same exports.
type Implements<Module extends Platform> = Module
export type Implementations = [Implements<typeof NodePlatform>, Implements<typeof BunPlatform>]
