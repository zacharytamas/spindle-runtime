import { describe, expect, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"
import { PlatformLive } from "#platform"
import { type Child, spindle } from "./processes.ts"

// A definition file is user code that runs while spindle validate loads it. These tests run the real command in a
// child process, because each fault reaches the process itself: an exception thrown from a timer, a rejected promise
// nobody handles, a call to process.exit, and a top-level await that never settles. Each child has a time limit, and
// the scope kills it when the test ends.

const LIMIT = "8 seconds"

const VALID = 'export default { description: "A valid tool", execute: async () => ({ status: "success" }) }'

// A file whose top-level await settles after 200 ms. It keeps the load running while a timer of another file fires.
const SLOW = `await new Promise((resolve) => setTimeout(resolve, 200))\n${VALID}`

const SUMMARY = /^(\d+) errors?, (\d+) warnings?$/

const project = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "spindle-isolation-" })
    yield* fs.makeDirectory(path.join(root, "agents", "tools"), { recursive: true })
    for (const [name, text] of Object.entries(files))
      yield* fs.writeFileString(path.join(root, "agents", "tools", name), `${text}\n`)
    return root
  })

const validate = (root: string, flags: ReadonlyArray<string> = []) =>
  Effect.gen(function* () {
    const child = yield* spindle(root, ["validate", ...flags, root])
    const exit = yield* child.exit.pipe(
      Effect.timeoutOrElse({
        duration: LIMIT,
        orElse: () => Effect.die(new Error(`spindle validate did not exit within ${LIMIT}`)),
      }),
    )
    return { exit, out: child.out, err: child.err }
  })

// A stack frame of Spindle's own code or of a package it depends on. Node and Bun both print a frame as "at ...".
const ownFrames = (child: Pick<Child, "err">) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const runtime = yield* path.fromFileUrl(new URL("../../", import.meta.url))
    return child.err.filter(
      (line) => /^\s*at\s/.test(line) && (line.includes(runtime) || line.includes("node_modules")),
    )
  })

const errorCount = (out: ReadonlyArray<string>) => {
  const summary = out.map((line) => SUMMARY.exec(line)).find((match) => match !== null)
  return summary ? Number(summary[1]) : undefined
}

describe("spindle validate with a definition file that reaches the process", () => {
  it.live(
    "prints its report and exits non-zero when a definition file throws from a timer after it loads",
    () =>
      Effect.gen(function* () {
        const root = yield* project({
          "late.js": `setTimeout(() => {\n  throw new Error("late failure")\n}, 0)\n${VALID}`,
          "slow.js": SLOW,
        })
        const run = yield* validate(root)
        expect(run.out.slice(-1)).toEqual([expect.stringMatching(SUMMARY)])
        expect(errorCount(run.out)).toBeGreaterThan(0)
        expect(run.exit).not.toBe(0)
        expect(yield* ownFrames(run)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    20_000,
  )

  it.live(
    "prints its report and exits non-zero when a definition file leaves a rejected promise unhandled",
    () =>
      Effect.gen(function* () {
        const root = yield* project({
          "orphan.js": `Promise.reject(new Error("nobody listens"))\n${VALID}`,
          "slow.js": SLOW,
        })
        const run = yield* validate(root)
        expect(run.out.slice(-1)).toEqual([expect.stringMatching(SUMMARY)])
        expect(errorCount(run.out)).toBeGreaterThan(0)
        expect(run.exit).not.toBe(0)
        expect(yield* ownFrames(run)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    20_000,
  )

  // The plan asks only that the run not end with code 0 and no report. Code 0 with a report of no errors would be the
  // same false pass to a caller that reads the exit code, so the test asks for a non-zero code.
  it.live(
    "does not exit 0 when a definition file calls process.exit(0) while it loads",
    () =>
      Effect.gen(function* () {
        const root = yield* project({ "quit.js": `process.exit(0)\n${VALID}`, "slow.js": SLOW })
        const run = yield* validate(root)
        expect({ exit: run.exit, out: run.out }).not.toEqual({ exit: 0, out: [] })
        expect(run.exit).not.toBe(0)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    20_000,
  )

  // --load-timeout takes seconds, the format of --hook-timeout. With 0.3 seconds the run ends in about a second; the
  // default of 30 seconds would outlast the child's time limit.
  it.live(
    "gives up on a top-level await that never settles after --load-timeout, names the file, and exits non-zero",
    () =>
      Effect.gen(function* () {
        const root = yield* project({ "stuck.js": `await new Promise(() => {})\n${VALID}`, "fine.js": VALID })
        const run = yield* validate(root, ["--load-timeout", "0.3"])
        expect(run.out.filter((line) => line.includes("agents/tools/stuck.js"))).toEqual([
          expect.stringMatching(/^\S+ error agents\/tools\/stuck\.js(:\S*)? /),
        ])
        expect(run.out.filter((line) => line.includes("fine.js"))).toEqual([])
        expect(run.out.slice(-1)).toEqual([expect.stringMatching(SUMMARY)])
        expect(run.exit).not.toBe(0)
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    20_000,
  )

  it.live(
    "documents --load-timeout as a number of seconds with a default of 30",
    () =>
      Effect.gen(function* () {
        const root = yield* project({})
        const child = yield* spindle(root, ["validate", "--help"])
        yield* child.exit.pipe(
          Effect.timeoutOrElse({
            duration: LIMIT,
            orElse: () => Effect.die(new Error(`spindle validate --help did not exit within ${LIMIT}`)),
          }),
        )
        expect(child.out.filter((line) => line.includes("--load-timeout"))).toEqual([
          expect.stringMatching(/--load-timeout\s+number\s+.*\bdefault is 30\b/i),
        ])
      }).pipe(Effect.scoped, Effect.provide(PlatformLive)),
    20_000,
  )
})
