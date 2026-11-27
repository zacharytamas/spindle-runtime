#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import { Effect, Layer } from "effect"
import { PlatformLive, SqliteLive } from "#platform"
import { createThread, stateAtRest } from "../src/execution/trigger.ts"
import { Registry } from "../src/registry/Registry.ts"
import { layer } from "../src/store/sqlite.ts"

const USAGE = `Usage: hook-probe inject --dir <project> --db <file> --agent <name> --role <role> --content <text> [--silent]

  Creates a thread for the agent, which runs its after_thread_created hooks, and injects one message into the
  thread at rest, which runs the agent's create hooks. Prints the returned message, the message that getMessage
  reads back, and the thread id. Run pnpm build first, because #platform resolves to dist outside Vitest.`

const [command = "help", ...args] = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

const inject = async () => {
  const dir = option("--dir")
  const db = option("--db")
  const agent = option("--agent")
  const role = option("--role")
  const content = option("--content")
  if (dir === undefined || db === undefined || agent === undefined || content === undefined) {
    console.log(USAGE)
    process.exitCode = 2
    return
  }
  if (role !== "user" && role !== "assistant" && role !== "system") {
    console.log("--role takes user, assistant, or system")
    process.exitCode = 2
    return
  }
  const root = path.resolve(dir)
  await Effect.runPromise(
    Effect.gen(function* () {
      const thread = yield* createThread(agent)
      const state = yield* stateAtRest(thread.id)
      const message = yield* Effect.promise(() =>
        state.injectMessage({ role, content, silent: args.includes("--silent") }),
      )
      const read = yield* Effect.promise(() => state.getMessage(message.id))
      console.log(`returned ${JSON.stringify(message)}`)
      console.log(`getMessage ${JSON.stringify(read)}`)
      console.log(`thread ${thread.id}`)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Registry.layer(root), Layer.provide(layer, SqliteLive({ filename: path.resolve(db) }))).pipe(
          Layer.provide(PlatformLive),
        ),
      ),
    ),
  )
}

if (command === "inject") await inject()
else console.log(USAGE)
