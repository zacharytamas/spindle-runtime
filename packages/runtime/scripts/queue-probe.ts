#!/usr/bin/env node
import path from "node:path"
import process from "node:process"
import type { ThreadState } from "@standardagents/spec"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import { PlatformLive, SqliteLive } from "#platform"
import { HolderTimeout, layer as supervisorLayer, ThreadSupervisor } from "../src/execution/ThreadSupervisor.ts"
import { createThread, stateAtRest } from "../src/execution/trigger.ts"
import { Registry } from "../src/registry/Registry.ts"
import { layer } from "../src/store/sqlite.ts"

const USAGE = `Usage: queue-probe <command> --dir <project> --db <file> [--holder-timeout <seconds>]

  create --agent <name>                          create a thread at rest and print its id
  queue-message --thread <id> --role <user|assistant> --content <text> [--silent]
  queue-tool --thread <id> --tool <name> --args <json>
  terminate --thread <id>
  status --thread <id>

Each command goes through the ThreadState that an endpoint sees at rest and prints one line: ok and the run status,
or refused and the error. A queue command that starts an execution here waits until it settles.
Run with --conditions=spindle-source, or run pnpm build first, because #platform resolves to dist otherwise.`

const [command = "help", ...args] = process.argv.slice(2)
const option = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const required = (name: string) => {
  const value = option(name)
  if (value === undefined) {
    console.log(USAGE)
    process.exit(2)
  }
  return value
}

const act = (state: ThreadState): Promise<unknown> => {
  switch (command) {
    case "queue-message":
      return state.queueMessage({
        role: required("role") as "user" | "assistant",
        content: required("content"),
        ...(args.includes("--silent") ? { silent: true } : {}),
      })
    case "queue-tool":
      return Promise.resolve().then(() => state.queueTool(required("tool"), JSON.parse(required("args"))))
    case "terminate":
      return state.terminate()
    default:
      return Promise.resolve()
  }
}

const main = Effect.gen(function* () {
  if (command === "create") {
    const thread = yield* createThread(required("agent"))
    console.log(`thread ${thread.id}`)
    return
  }
  const threadId = required("thread")
  const state = yield* stateAtRest(threadId)
  const done = yield* Effect.exit(Effect.tryPromise(() => act(state)))
  if (Exit.isFailure(done)) {
    const error = Cause.squash(done.cause)
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error
    console.log(`refused ${cause instanceof Error ? cause.message : String(cause)}`)
    process.exitCode = 1
    return
  }
  const supervisor = yield* ThreadSupervisor
  yield* supervisor.settled(threadId)
  console.log(`ok ${JSON.stringify(yield* supervisor.status(threadId))}`)
})

if (command === "help" || !["create", "queue-message", "queue-tool", "terminate", "status"].includes(command))
  console.log(USAGE)
else {
  const timeout = option("holder-timeout")
  await Effect.runPromise(
    main.pipe(
      Effect.provide(
        Layer.mergeAll(
          Registry.layer(path.resolve(required("dir"))),
          Layer.provideMerge(
            supervisorLayer().pipe(
              Layer.provide(
                timeout === undefined
                  ? Layer.empty
                  : Layer.succeed(HolderTimeout, Duration.millis(Number(timeout) * 1000)),
              ),
            ),
            Layer.provide(layer, SqliteLive({ filename: path.resolve(required("db")) })),
          ),
        ).pipe(Layer.provide(PlatformLive)),
      ),
    ),
  )
}
