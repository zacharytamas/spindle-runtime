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
}

// tsc resolves #platform to node.ts only, so this is what holds bun.ts to the same exports.
type Implements<Module extends Platform> = Module
export type Implementations = [Implements<typeof NodePlatform>, Implements<typeof BunPlatform>]
