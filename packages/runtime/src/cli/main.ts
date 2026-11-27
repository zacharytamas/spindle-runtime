#!/usr/bin/env node
import { SPEC_VERSION } from "@standardagents/spec"
import { Effect, FileSystem, Path, Schema } from "effect"
import { Command } from "effect/cli"
import { isMain, PlatformLive, platformName, runMain } from "#platform"
import { chatCommand } from "./chat.ts"
import { runCommand } from "./run.ts"
import { sendCommand } from "./send.ts"
import { recoverCommand, statusCommand } from "./status.ts"
import { validateCommand } from "./validate.ts"

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const packageVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* path.fromFileUrl(new URL("../../package.json", import.meta.url))
  const { version } = yield* Schema.decodeEffect(PackageJson)(yield* fs.readFileString(file))
  return version
})

export const spindle = Command.make("spindle").pipe(
  Command.withSubcommands([validateCommand, runCommand, chatCommand, sendCommand, statusCommand, recoverCommand]),
)

if (isMain(import.meta)) {
  Effect.gen(function* () {
    const version = yield* packageVersion
    yield* Command.run(spindle, { version: `${version} (spec ${SPEC_VERSION}, platform ${platformName})` })
  }).pipe(Effect.provide(PlatformLive), runMain)
}
