#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { Effect, Layer } from "effect"
import { PlatformLive, platformName, SqliteLive } from "#platform"
import { sendMessage } from "../src/execution/trigger.ts"
import { decodeScript, scriptedProvider } from "../src/providers/script.ts"
import { Registry } from "../src/registry/Registry.ts"
import { layer } from "../src/store/sqlite.ts"
import { ThreadStore } from "../src/store/ThreadStore.ts"

const USAGE = `Usage: step-probe <command>

  run            time one scripted run of the bench agent, 200 steps of one model call and one tool call each,
                 on a new file database, and print the result as one JSON line
  interleaved    --rounds <n>, run the probe on Node and on Bun in alternating order and print medians

Run pnpm build first, because #platform resolves to dist outside Vitest.`

const [command = "help", ...args] = process.argv.slice(2)
const project = path.join(import.meta.dirname, "../../conformance/fixtures/step-loop")

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

const run = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-step-probe-"))
  const filename = path.join(dir, "probe.db")
  try {
    const text = fs.readFileSync(path.join(project, "scripts/bench.json"), "utf8")
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = scriptedProvider(yield* decodeScript(text))
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "bench" })
        const started = performance.now()
        const outcome = yield* sendMessage(thread.id, "go", { provider })
        const elapsed = performance.now() - started
        const { total } = yield* store.getMessages(thread.id, { includeSilent: true, limit: 0 })
        return { outcome, elapsed, rows: total }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(Registry.layer(project), Layer.provide(layer, SqliteLive({ filename }))).pipe(
            Layer.provide(PlatformLive),
          ),
        ),
      ),
    )
    const ok =
      result.outcome.status === "idle" &&
      result.outcome.reason === "max_side_steps" &&
      result.outcome.steps === 200 &&
      result.rows === 401
    console.log(
      JSON.stringify({
        runtime: platformName,
        ok,
        reason: result.outcome.reason,
        steps: result.outcome.steps,
        rows: result.rows,
        totalMs: Number(result.elapsed.toFixed(2)),
        perStepMs: Number((result.elapsed / result.outcome.steps).toFixed(4)),
      }),
    )
    if (!ok) process.exitCode = 1
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const interleaved = () => {
  const index = args.indexOf("--rounds")
  const rounds = Number(index === -1 ? 10 : args[index + 1])
  const results: Record<"node" | "bun", Array<number>> = { node: [], bun: [] }
  let failures = 0
  for (let round = 1; round <= rounds; round++)
    for (const runtime of round % 2 === 1 ? (["node", "bun"] as const) : (["bun", "node"] as const)) {
      const child = spawnSync(runtime, [import.meta.filename, "run"], { encoding: "utf8" })
      const line = child.stdout.trim().split("\n").at(-1) ?? ""
      console.log(`round ${round} ${runtime} ${line}`)
      const parsed = line.startsWith("{") ? JSON.parse(line) : undefined
      if (child.status !== 0 || parsed?.ok !== true) failures += 1
      else results[runtime].push(parsed.perStepMs)
    }
  for (const runtime of ["node", "bun"] as const) {
    const values = results[runtime]
    console.log(
      `${runtime}: median ${median(values).toFixed(3)} ms per step, range ${Math.min(...values).toFixed(3)} to ${Math.max(...values).toFixed(3)} ms, ${values.length} rounds`,
    )
  }
  console.log(`failed rounds: ${failures}`)
  if (failures > 0) process.exitCode = 1
}

if (command === "run") await run()
else if (command === "interleaved") interleaved()
else console.log(USAGE)
