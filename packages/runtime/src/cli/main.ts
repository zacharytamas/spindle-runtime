#!/usr/bin/env node
import { SPEC_VERSION } from "@standardagents/spec"
import { Effect, FileSystem, Path, Schema } from "effect"
import { Command } from "effect/cli"
import { PlatformLive, platformName, runMain } from "#platform"

const PackageJson = Schema.fromJsonString(Schema.Struct({ version: Schema.String }))

const packageVersion = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = yield* path.fromFileUrl(new URL("../../package.json", import.meta.url))
  const { version } = yield* Schema.decodeUnknownEffect(PackageJson)(yield* fs.readFileString(file))
  return version
})

const spindle = Command.make("spindle")

Effect.gen(function* () {
  const version = yield* packageVersion
  yield* Command.run(spindle, { version: `${version} (spec ${SPEC_VERSION}, platform ${platformName})` })
}).pipe(Effect.provide(PlatformLive), runMain)
