#!/usr/bin/env node
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"
import { isDeepStrictEqual } from "node:util"
import type { Message } from "@standardagents/spec"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { platformName, SqliteLive } from "#platform"
import { layer } from "../src/store/sqlite.ts"
import { type NewMessage, ThreadStore } from "../src/store/ThreadStore.ts"
import { admitEntry, drainEntries } from "./store-fixtures.ts"

const USAGE = `Usage: store-probe <command> --db <file> [options]

Live lanes:
  roundtrip            write three messages, then read them back from a second process
  kill-after-append    SIGKILL a process after its append resolves, then read from a new process
  kill-mid-transaction SIGKILL a process inside a step transaction [--rounds <n> random kills]
  kv-roundtrip         set an object, read it, set null, read it again
  kv-isolation         write one key on a parent, a child, and a sibling thread
  kv-non-json          set a BigInt value
  queue-fifo           enqueue 100 entries in one process and dequeue them in another
  status-since         set the same status twice, then a new reason
  silent-reads         read a visible and a silent message with and without includeSilent
  cross-runtime        write on Node and read on Bun, then the reverse

Perf:
  bench                --appends <n> --reads <n>, time single appends and reads of 1,000 messages
  bench-interleaved    --rounds <n>, run bench on Node and on Bun in alternating order

Helpers that the lanes spawn:
  read --thread <id>, write, kv-write, append --thread <id> [--hold], step --thread <id> [--hold | --loop],
  enqueue --count <n>, dequeue --thread <id>`

const [command = "help", ...args] = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const required = (name: string): string => option(name) ?? fail(`--${name} is required`)
const has = (name: string) => args.includes(`--${name}`)
const fail = (message: string): never => {
  console.error(`store-probe ${command}: ${message}`)
  process.exit(1)
}

const print = (value: unknown) => console.log(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v)))

const startRun = (threadId: string) =>
  ThreadStore.use((store) =>
    Effect.gen(function* () {
      if (!(yield* store.claim(threadId, claim)))
        yield* store.admit(threadId, { kind: "message", message: { role: "user", content: "trigger" } }, claim)
      return (yield* store.getThread(threadId)).status
    }),
  )
const settleRun = (threadId: string, outcome: { state: "idle" | "failed"; reason: string }) =>
  ThreadStore.use((store) =>
    Effect.gen(function* () {
      yield* store.settle(threadId, claim.flowId, outcome, { continueIfQueued: false, closing: "" })
      return (yield* store.getThread(threadId)).status
    }),
  )
const claim = { holder: crypto.randomUUID(), flowId: crypto.randomUUID() }
const withStore = <A, E>(filename: string, use: Effect.Effect<A, E, ThreadStore | SqlClient>) =>
  Effect.runPromise(Effect.provide(use, Layer.provideMerge(layer, SqliteLive({ filename }))))

const runtimeCommand = (runtime: "node" | "bun") => (runtime === platformName ? process.execPath : runtime)

interface Child {
  readonly pid: number | undefined
  readonly lines: Array<string>
  readonly waitForLine: (predicate: (line: string) => boolean) => Promise<string>
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>
  readonly kill: (signal: NodeJS.Signals) => void
}

const spawnProbe = (subcommand: string, flags: Array<string>, runtime = platformName): Child => {
  const child = spawn(runtimeCommand(runtime), [import.meta.filename, subcommand, ...flags], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  const lines: Array<string> = []
  const waiters: Array<() => void> = []
  let buffer = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    buffer += chunk
    const parts = buffer.split("\n")
    buffer = parts.pop() ?? ""
    lines.push(...parts.filter((line) => line !== ""))
    for (const wake of waiters.splice(0)) wake()
  })
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk
  })
  let done = false
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => {
      done = true
      for (const wake of waiters.splice(0)) wake()
      const problems = stderr
        .split("\n")
        .filter((line) => line.trim() !== "" && !/ExperimentalWarning|--trace-warnings/.test(line))
      if (problems.length > 0) console.error(`[${runtime} ${subcommand} stderr] ${problems.join("\n")}`)
      resolve({ code, signal })
    }),
  )
  const waitForLine = async (predicate: (line: string) => boolean): Promise<string> => {
    for (;;) {
      const found = lines.find(predicate)
      if (found !== undefined) return found
      if (done) throw new Error(`${subcommand} exited before it printed the expected line`)
      await new Promise<void>((wake) => waiters.push(wake))
    }
  }
  return { pid: child.pid, lines, waitForLine, exited, kill: (signal) => child.kill(signal) }
}

const runProbe = async (subcommand: string, flags: Array<string>, runtime = platformName) => {
  const child = spawnProbe(subcommand, flags, runtime)
  const exit = await child.exited
  if (exit.code !== 0) fail(`${runtime} ${subcommand} exited with ${exit.code ?? exit.signal}`)
  const last = child.lines.at(-1)
  if (last === undefined) return fail(`${runtime} ${subcommand} printed nothing`)
  return { pid: child.pid, output: JSON.parse(last) }
}

// Bun exits once no timer or handle is left, even while a promise is pending, so a held child needs a timer.
const stayAlive = () => setInterval(() => {}, 60_000)

const killedBySignal = (exit: { readonly code: number | null; readonly signal: NodeJS.Signals | null }) => {
  if (exit.signal !== "SIGKILL") fail(`the child exited with ${JSON.stringify(exit)} instead of dying from SIGKILL`)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const toolCalls = (name: string, ...ids: Array<string>) =>
  JSON.stringify(ids.map((id) => ({ id, type: "function", function: { name, arguments: "{}" } })))

const stepRecords = (step: number): Array<NewMessage> => [
  { role: "assistant", content: null, tool_calls: toolCalls("lookup", `s${step}-a`, `s${step}-b`), metadata: { step } },
  {
    role: "tool",
    content: "a",
    name: "lookup",
    tool_call_id: `s${step}-a`,
    tool_status: "success",
    metadata: { step },
  },
  {
    role: "tool",
    content: "b",
    name: "lookup",
    tool_call_id: `s${step}-b`,
    tool_status: "success",
    metadata: { step },
  },
]

const createThread = (filename: string, agentId = "probe") =>
  withStore(
    filename,
    ThreadStore.use((store) => store.createThread({ agentId })),
  )

const readThread = (threadId: string) =>
  Effect.gen(function* () {
    const store = yield* ThreadStore
    return (yield* store.getMessages(threadId, { order: "asc", includeSilent: true })).messages
  })

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? Number.NaN)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}
const quantile = (values: ReadonlyArray<number>, q: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Number.NaN
}
const round = (ms: number) => Math.round(ms * 1000) / 1000

const commands: Record<string, () => Promise<void>> = {
  read: async () => {
    const messages = await withStore(required("db"), readThread(required("thread")))
    print({ runtime: platformName, pid: process.pid, thread: required("thread"), messages })
  },

  write: async () => {
    const db = required("db")
    const written = await withStore(
      db,
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: `written-by-${platformName}` })
        const messages = yield* store.appendMessages(thread.id, [
          { role: "user", content: `hello from ${platformName}` },
          {
            role: "assistant",
            content: null,
            tool_calls: toolCalls("lookup", "call-1"),
            reasoning_content: "look it up",
          },
          { role: "tool", content: "42", name: "lookup", tool_call_id: "call-1", tool_status: "success" },
        ])
        return { thread: thread.id, messages }
      }),
    )
    print({ runtime: platformName, pid: process.pid, ...written })
  },

  roundtrip: async () => {
    const db = required("db")
    const written = await withStore(
      db,
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "roundtrip" })
        yield* store.appendMessages(thread.id, [{ role: "user", content: "What is 6 times 7?" }])
        yield* store.appendMessages(thread.id, [
          { role: "assistant", content: null, tool_calls: toolCalls("multiply", "call-1") },
          { role: "tool", content: "42", name: "multiply", tool_call_id: "call-1", tool_status: "success" },
        ])
        return { thread: thread.id, messages: yield* readThread(thread.id) }
      }),
    )
    print({ runtime: platformName, pid: process.pid, ...written })
    const second = await runProbe("read", ["--db", db, "--thread", written.thread])
    print(second.output)
    print({
      secondProcessPid: second.pid,
      sameRecordsInSameOrder: isDeepStrictEqual(second.output.messages, written.messages),
    })
  },

  append: async () => {
    const [message] = await withStore(
      required("db"),
      ThreadStore.use((store) =>
        store.appendMessages(required("thread"), [{ role: "user", content: option("content") ?? "appended" }]),
      ),
    )
    print({ runtime: platformName, pid: process.pid, appended: message })
    if (has("hold")) stayAlive()
  },

  "kill-after-append": async () => {
    const db = required("db")
    const thread = await createThread(db)
    const child = spawnProbe("append", ["--db", db, "--thread", thread.id, "--content", "survives SIGKILL", "--hold"])
    const appended = JSON.parse(await child.waitForLine((line) => line.includes('"appended"'))).appended as Message
    child.kill("SIGKILL")
    const exit = await child.exited
    print({ child: child.pid, printed: "appended", appendedId: appended.id, exit })
    killedBySignal(exit)
    const after = await runProbe("read", ["--db", db, "--thread", thread.id])
    print({
      reader: after.pid,
      messageIds: after.output.messages.map((m: Message) => m.id),
      present: after.output.messages.some((m: Message) => isDeepStrictEqual(m, appended)),
    })
  },

  step: async () => {
    const db = required("db")
    const threadId = required("thread")
    await withStore(
      db,
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const oneStep = (step: number, hold: boolean) =>
          store.transaction(
            Effect.gen(function* () {
              const [assistant, ...results] = stepRecords(step)
              yield* store.appendMessages(threadId, assistant === undefined ? [] : [assistant])
              yield* store.appendMessages(threadId, results)
              if (hold) {
                stayAlive()
                print({ runtime: platformName, pid: process.pid, insideTransaction: true, written: 3, step })
                return yield* Effect.never
              }
            }),
          )
        if (has("loop"))
          for (let step = 1; ; step++) {
            yield* oneStep(step, false)
            if (step === 1) print({ runtime: platformName, pid: process.pid, looping: true })
          }
        yield* oneStep(1, has("hold"))
        print({ runtime: platformName, pid: process.pid, committed: 1 })
      }),
    )
  },

  "kill-mid-transaction": async () => {
    const db = required("db")
    const rounds = Number(option("rounds") ?? 0)
    const thread = await createThread(db)
    const child = spawnProbe("step", ["--db", db, "--thread", thread.id, "--hold"])
    await child.waitForLine((line) => line.includes('"insideTransaction"'))
    child.kill("SIGKILL")
    const exit = await child.exited
    const after = await runProbe("read", ["--db", db, "--thread", thread.id])
    const found = after.output.messages.length
    print({ child: child.pid, killedInside: "a transaction that wrote 3 records", exit, recordsFound: found })
    killedBySignal(exit)
    const randomRounds = []
    for (let n = 0; n < rounds; n++) {
      const looped = await createThread(db)
      const looping = spawnProbe("step", ["--db", db, "--thread", looped.id, "--loop"])
      await looping.waitForLine((line) => line.includes('"looping"'))
      await sleep(Math.floor(Math.random() * 200))
      looping.kill("SIGKILL")
      killedBySignal(await looping.exited)
      const read = await runProbe("read", ["--db", db, "--thread", looped.id])
      const perStep = new Map<number, number>()
      for (const m of read.output.messages as Array<Message>) {
        const step = Number(m.metadata?.step)
        perStep.set(step, (perStep.get(step) ?? 0) + 1)
      }
      randomRounds.push({
        steps: perStep.size,
        incompleteSteps: [...perStep.values()].filter((count) => count !== 3).length,
      })
    }
    print({
      allOrNone: found === 0 || found === 3,
      ...(rounds > 0
        ? {
            randomKillRounds: rounds,
            committedSteps: randomRounds.reduce((sum, r) => sum + r.steps, 0),
            incompleteSteps: randomRounds.reduce((sum, r) => sum + r.incompleteSteps, 0),
          }
        : {}),
    })
  },

  "kv-write": async () => {
    const result = await withStore(
      required("db"),
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "kv" })
        const value = { theme: "dark", locale: "en-US" }
        yield* store.setValue(thread.id, "preferences", value)
        return { thread: thread.id, key: "preferences", value }
      }),
    )
    print({ runtime: platformName, pid: process.pid, ...result })
  },

  "kv-roundtrip": async () => {
    const result = await withStore(
      required("db"),
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "kv" })
        const value = { theme: "dark", locale: "en-US", recent: [1, 2, 3], nested: { on: true, none: null } }
        yield* store.setValue(thread.id, "preferences", value)
        const first = yield* store.getValue(thread.id, "preferences")
        yield* store.setValue(thread.id, "preferences", null)
        const second = yield* store.getValue(thread.id, "preferences")
        return { thread: thread.id, set: value, firstRead: first, secondRead: second }
      }),
    )
    print({ ...result, firstEqualsSet: isDeepStrictEqual(result.firstRead, result.set) })
  },

  "kv-isolation": async () => {
    const result = await withStore(
      required("db"),
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const parent = yield* store.createThread({ agentId: "parent" })
        const child = yield* store.createThread({ agentId: "child", parentId: parent.id })
        const sibling = yield* store.createThread({ agentId: "sibling", parentId: parent.id })
        const threads = { parent, child, sibling }
        for (const [name, thread] of Object.entries(threads))
          yield* store.setValue(thread.id, "shared_key", `${name} value`)
        const reads: Record<string, unknown> = {}
        for (const [name, thread] of Object.entries(threads))
          reads[name] = yield* store.getValue(thread.id, "shared_key")
        return { threads: Object.fromEntries(Object.entries(threads).map(([k, t]) => [k, t.id])), reads }
      }),
    )
    print({ ...result, eachReadsOwn: Object.entries(result.reads).every(([name, value]) => value === `${name} value`) })
  },

  "kv-non-json": async () => {
    const result = await withStore(
      required("db"),
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const sql = yield* SqlClient
        const thread = yield* store.createThread({ agentId: "kv" })
        const error = yield* Effect.flip(store.setValue(thread.id, "big_number", 12345678901234567890n))
        const rows = yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM kv WHERE thread_id = ${thread.id} AND key = 'big_number'`
        return {
          thread: thread.id,
          error: { tag: error._tag, message: error.message },
          kvRowsForKey: rows[0]?.n,
          getValue: yield* store.getValue(thread.id, "big_number"),
        }
      }),
    )
    print(result)
  },

  enqueue: async () => {
    const count = Number(option("count") ?? 100)
    const result = await withStore(
      required("db"),
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "queue" })
        const labels: Array<string> = []
        for (let n = 0; n < count; n++) {
          if (n % 3 === 2) {
            yield* admitEntry(thread.id, { kind: "tool", toolName: "lookup", args: { n } }, claim)
            labels.push(`tool:${n}`)
          } else {
            yield* admitEntry(thread.id, { kind: "message", message: { role: "user", content: `message ${n}` } }, claim)
            labels.push(`message:${n}`)
          }
        }
        return { thread: thread.id, enqueued: labels }
      }),
    )
    print({ runtime: platformName, pid: process.pid, ...result })
  },

  dequeue: async () => {
    const taken = await withStore(
      required("db"),
      ThreadStore.use((store) =>
        Effect.gen(function* () {
          const threadId = required("thread")
          yield* store.recover(threadId)
          if (!(yield* store.claim(threadId, claim))) return []
          const taken = yield* drainEntries(threadId, claim.flowId)
          yield* settleRun(threadId, { state: "idle", reason: "awaiting_human" })
          return taken
        }),
      ),
    )
    const dequeued = taken.map((entry) =>
      entry.kind === "tool" ? `tool:${entry.args.n}` : `message:${entry.message.content.replace("message ", "")}`,
    )
    print({ runtime: platformName, pid: process.pid, dequeued })
  },

  "queue-fifo": async () => {
    const db = required("db")
    const writer = await runProbe("enqueue", ["--db", db, "--count", "100"])
    const reader = await runProbe("dequeue", ["--db", db, "--thread", writer.output.thread])
    print(writer.output)
    print(reader.output)
    print({
      enqueuedBy: writer.pid,
      dequeuedBy: reader.pid,
      count: reader.output.dequeued.length,
      dequeueOrderEqualsEnqueueOrder: isDeepStrictEqual(reader.output.dequeued, writer.output.enqueued),
    })
  },

  "status-since": async () => {
    const result = await withStore(
      required("db"),
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "status" })
        const initial = (yield* store.getThread(thread.id)).status
        yield* startRun(thread.id)
        const first = yield* settleRun(thread.id, { state: "idle", reason: "stop_on_response" })
        yield* Effect.sleep("5 millis")
        const second = yield* settleRun(thread.id, { state: "idle", reason: "stop_on_response" })
        yield* Effect.sleep("5 millis")
        yield* startRun(thread.id)
        const third = yield* settleRun(thread.id, { state: "idle", reason: "stop_tool" })
        return { thread: thread.id, initial, first, second, third }
      }),
    )
    print({
      ...result,
      sinceUnchangedAfterSecond: result.second.since === result.first.since,
      sinceChangedAfterThird: result.third.since !== result.second.since,
    })
  },

  "silent-reads": async () => {
    const result = await withStore(
      required("db"),
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const thread = yield* store.createThread({ agentId: "silent" })
        yield* store.appendMessages(thread.id, [{ role: "user", content: "visible" }])
        yield* store.appendMessages(thread.id, [{ role: "user", content: "silent", silent: true }])
        const ordinary = yield* store.getMessages(thread.id)
        const all = yield* store.getMessages(thread.id, { includeSilent: true })
        return {
          thread: thread.id,
          defaultRead: ordinary.messages.map((m) => m.content),
          includeSilentRead: all.messages.map((m) => m.content),
        }
      }),
    )
    print({ ...result, defaultCount: result.defaultRead.length, includeSilentCount: result.includeSilentRead.length })
  },

  "cross-runtime": async () => {
    const db = required("db")
    const results = []
    for (const [writer, reader] of [
      ["node", "bun"],
      ["bun", "node"],
    ] as const) {
      const written = await runProbe("write", ["--db", db], writer)
      const read = await runProbe("read", ["--db", db, "--thread", written.output.thread], reader)
      print(written.output)
      print(read.output)
      results.push({
        writer: written.output.runtime,
        reader: read.output.runtime,
        thread: written.output.thread,
        readerSawWriterRecords: isDeepStrictEqual(read.output.messages, written.output.messages),
      })
    }
    print({ results })
  },

  bench: async () => {
    const appends = Number(option("appends") ?? 2000)
    const reads = Number(option("reads") ?? 50)
    const result = await withStore(
      required("db"),
      Effect.gen(function* () {
        const store = yield* ThreadStore
        const sql = yield* SqlClient
        const [info] = yield* sql<{ version: string; journal: string; synchronous: number }>`
          SELECT sqlite_version() AS version,
            (SELECT journal_mode FROM pragma_journal_mode) AS journal,
            (SELECT synchronous FROM pragma_synchronous) AS synchronous`
        const thread = yield* store.createThread({ agentId: "bench" })
        const appendMs: Array<number> = []
        for (let n = 0; n < appends; n++) {
          const message: NewMessage = { role: n % 2 === 0 ? "user" : "assistant", content: `message ${n} `.repeat(8) }
          const start = performance.now()
          yield* store.appendMessages(thread.id, [message])
          appendMs.push(performance.now() - start)
        }
        const readMs: Array<number> = []
        let returned = 0
        for (let n = 0; n < reads; n++) {
          const start = performance.now()
          const page = yield* store.getMessages(thread.id, { limit: 1000, order: "asc" })
          readMs.push(performance.now() - start)
          returned = page.messages.length
        }
        const [stored] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM messages WHERE thread_id = ${thread.id}`
        return {
          runtime: platformName,
          runtimeVersion: process.versions.bun ?? process.versions.node,
          sqliteVersion: info?.version,
          journalMode: info?.journal,
          synchronous: info?.synchronous,
          appends,
          rowsStored: stored?.n,
          appendMedianMs: round(median(appendMs)),
          appendP95Ms: round(quantile(appendMs, 0.95)),
          reads,
          messagesPerRead: returned,
          read1000MedianMs: round(median(readMs)),
          read1000P95Ms: round(quantile(readMs, 0.95)),
        }
      }),
    )
    print(result)
  },

  "bench-interleaved": async () => {
    const rounds = Number(option("rounds") ?? 10)
    const dir = option("dir") ?? fs.mkdtempSync(path.join(os.tmpdir(), "spindle-bench-"))
    const flags = ["--appends", option("appends") ?? "2000", "--reads", option("reads") ?? "50"]
    const results: Record<"node" | "bun", Array<{ appendMedianMs: number; read1000MedianMs: number }>> = {
      node: [],
      bun: [],
    }
    for (let n = 0; n < rounds; n++) {
      const order = n % 2 === 0 ? (["node", "bun"] as const) : (["bun", "node"] as const)
      for (const runtime of order) {
        const run = await runProbe("bench", ["--db", path.join(dir, `${runtime}-${n}.db`), ...flags], runtime)
        print({ round: n + 1, ...run.output })
        results[runtime].push(run.output)
      }
    }
    const summary = (runs: (typeof results)["node"]) => ({
      rounds: runs.length,
      appendMedianMs: round(median(runs.map((r) => r.appendMedianMs))),
      appendRangeMs: [
        round(Math.min(...runs.map((r) => r.appendMedianMs))),
        round(Math.max(...runs.map((r) => r.appendMedianMs))),
      ],
      read1000MedianMs: round(median(runs.map((r) => r.read1000MedianMs))),
      read1000RangeMs: [
        round(Math.min(...runs.map((r) => r.read1000MedianMs))),
        round(Math.max(...runs.map((r) => r.read1000MedianMs))),
      ],
    })
    print({ dir, node: summary(results.node), bun: summary(results.bun) })
  },
}

const run = commands[command]
if (run === undefined) {
  console.log(USAGE)
  process.exit(command === "help" || command === "--help" ? 0 : 2)
} else {
  run().catch((error: unknown) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)))
}
