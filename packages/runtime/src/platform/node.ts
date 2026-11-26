import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import type { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export const platformName = "node";

export const PlatformLive = NodeServices.layer;

// Loading node:sqlite prints an ExperimentalWarning on Node 22, so only commands that open a database load it.
export const SqliteLive = (options: { readonly filename: string }): Layer.Layer<SqlClient, SqlError> =>
	Layer.unwrap(
		Effect.promise(() => import("@effect/sql-sqlite-node")).pipe(
			Effect.map(({ SqliteClient }) => SqliteClient.layer(options)),
		),
	);

export const runMain = NodeRuntime.runMain;
