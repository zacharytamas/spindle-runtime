import { ConfigProvider, Duration, Effect, FileSystem, Layer, Logger, ManagedRuntime, Path } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { PlatformLive, SqliteLive } from "#platform"
import type {
  LoadOptions,
  Project,
  RunOutcome,
  RuntimeDriver,
  RuntimeSession,
  StoredThread,
} from "../../conformance/src/RuntimeDriver.ts"
import { appendMessages } from "../scripts/store-fixtures.ts"
import { HookTimeout } from "../src/execution/hooks.ts"
import { layer as supervisorLayer, ThreadSupervisor } from "../src/execution/ThreadSupervisor.ts"
import { createThread, sendMessage, stateAtRest } from "../src/execution/trigger.ts"
import { type Definition, type Kind, Registry } from "../src/registry/Registry.ts"
import { resolver } from "../src/registry/resolve.ts"
import { validate } from "../src/registry/validate.ts"
import { MessageStore } from "../src/store/MessageStore.ts"
import { RunStore } from "../src/store/RunStore.ts"
import { layer as storeLayer } from "../src/store/sqlite.ts"

const definition = (kind: Kind, name: string, value: unknown): Definition => ({
  kind,
  name,
  qualifiedName: name,
  package: undefined,
  file: `memory/${kind}s/${name}`,
  path: "",
  load: Effect.succeed(value),
})

// The scenarios define a project in memory, so this registry holds the values without a directory.
export const registryOf = (project: Project) => {
  const definitions = [
    ...project.agents.map((agent) => definition("agent", agent.name, agent)),
    ...project.prompts.map((prompt) => definition("prompt", prompt.name, prompt)),
    ...project.models.map((model) => definition("model", model.name, model)),
    ...Object.entries(project.tools ?? {}).map(([name, tool]) => definition("tool", name, tool)),
    ...(project.hooks ?? []).map((hook) => definition("hook", hook.id, hook)),
  ]
  const loaded = new Map<Definition, unknown>()
  for (const entry of definitions) loaded.set(entry, Effect.runSync(entry.load))
  return Layer.succeed(Registry, {
    root: "memory",
    definitions,
    packages: [],
    loaded,
    issues: [],
    resolve: resolver(definitions),
  })
}

type Row = Record<string, unknown>

const text = (value: unknown) => (typeof value === "string" ? value : null)
const count = (value: unknown) => (typeof value === "number" ? value : null)

// The rows are read with SELECT *, so that a column this version of the store does not have reads as absent.
const inspectThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const [thread] = yield* sql.unsafe<Row>("SELECT * FROM threads WHERE id = ?", [threadId])
    if (thread === undefined) return yield* Effect.die(new Error(`no thread ${threadId}`))
    const holders = yield* sql.unsafe<Row>("SELECT * FROM holders WHERE id = ?", [thread.holder_id ?? ""])
    const messages = yield* sql.unsafe<Row>("SELECT * FROM messages WHERE thread_id = ? ORDER BY seq", [threadId])
    const queue = yield* sql.unsafe<Row>("SELECT * FROM queue WHERE thread_id = ? ORDER BY seq", [threadId])
    const values = yield* sql.unsafe<Row>("SELECT * FROM kv WHERE thread_id = ? ORDER BY key", [threadId])
    const flowId = text(thread.flow_id)
    return {
      status: {
        state: thread.run_state as StoredThread["status"]["state"],
        since: Number(thread.run_since),
        reason: text(thread.run_reason),
      },
      terminated: count(thread.terminated_at),
      claim: flowId === null ? null : { flowId, pid: count(holders[0]?.pid) },
      revision: Number(thread.revision),
      messages: messages.map((row) => ({
        id: String(row.id),
        seq: Number(row.seq),
        role: String(row.role),
        content: text(row.content),
        flowId: text(row.flow_id),
        callerSeq: count(row.caller_seq),
      })),
      queue: queue.map((row) => ({
        seq: Number(row.seq),
        kind: String(row.kind),
        payload: String(row.payload),
        failed: row.disposition === "failed_delivery",
      })),
      values: Object.fromEntries(values.map((row) => [String(row.key), JSON.parse(String(row.value))])),
    } satisfies StoredThread
  })

const store = (filename: string) => Layer.fresh(storeLayer.pipe(Layer.provide(SqliteLive({ filename }))))

// Each session owns a connection and a distinct holder in this test process.
const openSession = (
  registry: ReturnType<typeof registryOf>,
  filename: string,
  options: LoadOptions,
  cleanup: () => Promise<void>,
): RuntimeSession => {
  const logs: Array<string> = []
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      registry,
      Layer.provideMerge(supervisorLayer(), store(filename)),
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(options.instanceEnv ?? {})),
      Logger.layer([Logger.make((entry) => logs.push(Logger.formatSimple.log(entry)))]),
      options.hookTimeoutMs === undefined
        ? Layer.empty
        : Layer.succeed(HookTimeout, Duration.millis(options.hookTimeoutMs)),
    ),
  )
  const reader = ManagedRuntime.make(store(filename))
  // A connection without the store, for the rows themselves.
  const rows = ManagedRuntime.make(Layer.fresh(SqliteLive({ filename })))
  const withSql = <A, E>(use: (sql: SqlClient) => Effect.Effect<A, E>) =>
    rows.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* SqlClient)
      }),
    )
  return {
    createThread: (agent) => runtime.runPromise(Effect.map(createThread(agent), (thread) => thread.id)),
    state: (threadId) => runtime.runPromise(stateAtRest(threadId)),
    logs: () => [...logs],
    send: (threadId, content, sendOptions = {}) =>
      runtime
        .runPromise(
          sendMessage(threadId, content, {
            ...(sendOptions.retries === undefined ? {} : { retries: sendOptions.retries }),
            ...(sendOptions.stepCap === undefined ? {} : { stepCap: sendOptions.stepCap }),
          }),
        )
        .then(
          (delivery): RunOutcome =>
            delivery.outcome ?? {
              status: delivery.status.state === "failed" ? "failed" : "idle",
              reason: delivery.status.reason ?? "",
              steps: 0,
              modelCalls: [],
            },
        ),
    settled: (threadId) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const supervisor = yield* ThreadSupervisor
          return yield* supervisor.settled(threadId)
        }),
      ),
    peer: async () => openSession(registry, filename, options, async () => {}),
    messages: (threadId) =>
      reader
        .runPromise(MessageStore.use((s) => s.getMessages(threadId, { order: "asc", includeSilent: true })))
        .then((result) => result.messages),
    seed: (threadId, messages) => reader.runPromise(appendMessages(threadId, messages)).then(() => undefined),
    abort: (threadId) =>
      runtime.runPromise(
        Effect.gen(function* () {
          const supervisor = yield* ThreadSupervisor
          return (yield* supervisor.abort(threadId)) !== undefined
        }),
      ),
    inspect: (threadId) => rows.runPromise(inspectThread(threadId)),
    forceRecover: (threadId) =>
      reader.runPromise(RunStore.use((s) => s.recoverThread(threadId, true))).then(() => undefined),
    queueRaw: (threadId, kind, payload) =>
      withSql((sql) =>
        sql.unsafe("INSERT INTO queue (thread_id, kind, payload, queued_at) VALUES (?, ?, ?, 0)", [
          threadId,
          kind,
          payload,
        ]),
      ).then(() => undefined),
    // A trigger cannot take a bound value, and a thread id is a UUID that the runtime made.
    breakSettlement: (threadId) =>
      /^[0-9a-f-]{36}$/.test(threadId)
        ? withSql((sql) =>
            sql.unsafe(
              `CREATE TRIGGER driver_break_settlement BEFORE UPDATE ON threads
               WHEN OLD.id = '${threadId}' AND OLD.run_state = 'running' AND NEW.run_state <> 'running'
               BEGIN SELECT RAISE(ABORT, 'the disk is full'); END`,
            ),
          ).then(() => undefined)
        : Promise.reject(new Error(`${threadId} is not a thread id`)),
    close: async () => {
      await runtime.dispose()
      await reader.dispose()
      await rows.dispose()
      await cleanup()
    },
  }
}

export const spindleDriver: RuntimeDriver = {
  name: "spindle",
  load: async (project, options = {}) => {
    const registry = registryOf(project)
    const { issues } = await Effect.runPromise(validate.pipe(Effect.provide(registry)))
    const errors = issues.filter((issue) => issue.severity === "error")
    if (errors.length > 0)
      throw new Error(errors.map((issue) => `${issue.code} ${issue.file}:${issue.path} ${issue.message}`).join("\n"))
    const { dir, filename } = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* fs.makeTempDirectory({ prefix: "spindle-driver-" })
        return { dir, filename: path.join(dir, "spindle.db") }
      }).pipe(Effect.provide(PlatformLive)),
    )
    return openSession(registry, filename, options, () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          yield* fs.remove(dir, { recursive: true })
        }).pipe(Effect.provide(PlatformLive)),
      ),
    )
  },
}
