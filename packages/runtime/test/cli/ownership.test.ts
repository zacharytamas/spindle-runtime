import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { PlatformLive } from "#platform"
import { entries, probe, project, query, setup, spindle, threadIn, touch, until } from "./processes.ts"

const DAY_MS = 24 * 60 * 60 * 1000

const status = (gate: string, db: string, thread: string, clockShiftMs?: number) =>
  Effect.gen(function* () {
    const child = yield* spindle(
      gate,
      ["status", thread, "--db", db],
      clockShiftMs === undefined ? {} : { clockShiftMs },
    )
    return { exit: yield* child.exit, out: child.out }
  })

describe("spindle ownership across processes", () => {
  it.live(
    "a status read settles a thread whose process was killed as lost at once, even with a clock that is a day behind",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-model"))
        const lost = yield* spindle(gate, ["run", "assistant", "-m", "first", ...project, "--db", db])
        const thread = yield* threadIn(lost)
        yield* until(
          "the process to enter the model",
          Effect.map(entries(gate), (names) => names.some((name) => name.startsWith("model-entered-"))),
        )
        yield* lost.signal("SIGKILL")
        yield* lost.exit
        const read = yield* status(gate, db, thread, -DAY_MS)
        expect([read.exit, read.out]).toEqual([0, [expect.stringMatching(/^failed execution_lost since /), "queued 0"]])
        yield* touch(at("release-model"))
        const again = yield* spindle(gate, ["send", thread, "-m", "again", ...project, "--db", db])
        expect([yield* again.exit, again.out]).toEqual([0, ["ack: first | again"]])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )

  it.live(
    "a status read with a clock that is a day ahead reports running for a holder that is alive and for one it may not signal",
    () =>
      Effect.gen(function* () {
        const { gate, db, at } = yield* setup
        yield* touch(at("hold-model"))
        const run = yield* spindle(gate, ["run", "assistant", "-m", "first", ...project, "--db", db])
        const thread = yield* threadIn(run)
        yield* until(
          "the process to enter the model",
          Effect.map(entries(gate), (names) => names.some((name) => name.startsWith("model-entered-"))),
        )
        const alive = yield* status(gate, db, thread, DAY_MS)
        // Process 1 belongs to the system, so a probe of it from a test gets a permission error or finds it alive.
        yield* query(db, "UPDATE holders SET pid = 1")
        const foreign = yield* status(gate, db, thread, DAY_MS)
        expect([alive.out.slice(0, 2), foreign.out.slice(0, 2)]).toEqual([
          [expect.stringMatching(/^running none since /), `held by process ${run.pid}`],
          [expect.stringMatching(/^running none since /), "held by process 1"],
        ])
        yield* touch(at("release-model"))
        expect([yield* run.exit, run.out]).toEqual([0, ["ack: first"]])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    60_000,
  )
})
