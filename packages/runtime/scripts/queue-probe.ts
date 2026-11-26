#!/usr/bin/env node
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import type { ThreadState } from "@standardagents/spec"
import { Cause, Effect, Exit, Layer } from "effect"
import { PlatformLive, SqliteLive } from "#platform"
import { layer as supervisorLayer, ThreadSupervisor } from "../src/execution/ThreadSupervisor.ts"
import { createThread, stateAtRest } from "../src/execution/trigger.ts"
import { scriptedProvider } from "../src/providers/script.ts"
import { Registry } from "../src/registry/Registry.ts"
import { layer } from "../src/store/sqlite.ts"
import { ThreadStore } from "../src/store/ThreadStore.ts"

const USAGE = `Usage: queue-probe <command> --dir <project> --db <file>

  create --agent <name>                          create a thread at rest and print its id
  queue-message --thread <id> --role <user|assistant> --content <text> [--silent]
  queue-tool --thread <id> --tool <name> --args <json>
  terminate --thread <id>
  status --thread <id>
  bench [--threads <n>] [--messages <n>] [--sequential]
                                                 queue messages to new threads of the step-loop assistant on a new file
                                                 database, wait until every thread rests, and print the time as JSON.
                                                 With --sequential, each thread waits for the run of one message before
                                                 it queues the next, so every message is its own run.

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

// The perf probe of the M1-6 plan: each thread gets its messages through queueMessage at rest, so the first starts an
// execution and the rest wait in its queue. A scripted provider answers every request at once.
const bench = Effect.gen(function* () {
  const threads = Number(option("threads") ?? 100)
  const messages = Number(option("messages") ?? 10)
  const store = yield* ThreadStore
  const supervisor = yield* ThreadSupervisor
  const ids: Array<string> = []
  for (let index = 0; index < threads; index++) ids.push((yield* createThread("assistant")).id)
  const states = yield* Effect.forEach(ids, stateAtRest, { concurrency: 1 })
  const sequential = args.includes("--sequential")
  const rest = (id: string) =>
    Effect.gen(function* () {
      yield* supervisor.settled(id)
      while ((yield* supervisor.status(id)).state === "running") yield* Effect.sleep("1 millis")
    })
  const started = performance.now()
  yield* Effect.forEach(
    states,
    (state) =>
      Effect.gen(function* () {
        for (let index = 0; index < messages; index++) {
          yield* Effect.promise(() => state.queueMessage({ role: "user", content: `message ${index}` }))
          if (sequential) yield* rest(state.threadId)
        }
      }),
    { concurrency: "unbounded" },
  )
  for (const id of ids) yield* rest(id)
  const elapsed = performance.now() - started
  let stored = 0
  let replies = 0
  let left = 0
  for (const id of ids) {
    const listed = (yield* store.getMessages(id, { includeSilent: true, order: "asc" })).messages
    stored += listed.filter((message) => message.role === "user").length
    replies += listed.filter((message) => message.role === "assistant").length
    left += yield* store.queueLength(id)
  }
  const ok = stored === threads * messages && left === 0 && replies > 0
  console.log(
    JSON.stringify({
      runtime: process.versions.bun === undefined ? "node" : "bun",
      threads,
      messages,
      sequential,
      ok,
      stored,
      replies,
      left,
      elapsedMs: Number(elapsed.toFixed(1)),
    }),
  )
  if (!ok) process.exitCode = 1
})

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

if (command === "bench") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-queue-bench-"))
  try {
    await Effect.runPromise(
      bench.pipe(
        Effect.provide(
          Layer.mergeAll(
            Registry.layer(path.join(import.meta.dirname, "../../conformance/fixtures/step-loop")),
            Layer.provideMerge(
              supervisorLayer({ provider: scriptedProvider({ responses: [{ text: "ok" }], repeat: true }) }),
              Layer.provide(layer, SqliteLive({ filename: path.join(dir, "bench.db") })),
            ),
          ).pipe(Layer.provide(PlatformLive)),
        ),
      ),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
} else if (command === "help" || !["create", "queue-message", "queue-tool", "terminate", "status"].includes(command))
  console.log(USAGE)
else {
  await Effect.runPromise(
    main.pipe(
      Effect.provide(
        Layer.mergeAll(
          Registry.layer(path.resolve(required("dir"))),
          Layer.provideMerge(
            supervisorLayer(),
            Layer.provide(layer, SqliteLive({ filename: path.resolve(required("db")) })),
          ),
        ).pipe(Layer.provide(PlatformLive)),
      ),
    ),
  )
}
