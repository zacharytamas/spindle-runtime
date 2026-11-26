import { ConfigProvider, Duration, Effect, FileSystem, Layer, Logger, ManagedRuntime, Path } from "effect"
import { PlatformLive, SqliteLive } from "#platform"
import type { Project, RunOutcome, RuntimeDriver } from "../../conformance/src/RuntimeDriver.ts"
import { HookTimeout } from "../src/execution/hooks.ts"
import { createThread, sendMessage, stateAtRest } from "../src/execution/trigger.ts"
import { type Definition, type Kind, Registry } from "../src/registry/Registry.ts"
import { resolver } from "../src/registry/resolve.ts"
import { validate } from "../src/registry/validate.ts"
import { layer as storeLayer } from "../src/store/sqlite.ts"
import { ThreadStore } from "../src/store/ThreadStore.ts"

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

const store = (filename: string) => Layer.fresh(storeLayer.pipe(Layer.provide(SqliteLive({ filename }))))

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
    const logs: Array<string> = []
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        registry,
        store(filename),
        ConfigProvider.layer(ConfigProvider.fromEnvRecord(options.instanceEnv ?? {})),
        Logger.layer([Logger.make((entry) => logs.push(Logger.formatSimple.log(entry)))]),
        options.hookTimeoutMs === undefined
          ? Layer.empty
          : Layer.succeed(HookTimeout, Duration.millis(options.hookTimeoutMs)),
      ),
    )
    const reader = ManagedRuntime.make(store(filename))
    const withStore = <A, E>(use: (store: ThreadStore["Service"]) => Effect.Effect<A, E>) =>
      reader.runPromise(
        Effect.gen(function* () {
          return yield* use(yield* ThreadStore)
        }),
      )
    return {
      createThread: (agent) => runtime.runPromise(Effect.map(createThread(agent), (thread) => thread.id)),
      state: (threadId) => runtime.runPromise(stateAtRest(threadId)),
      logs: () => [...logs],
      send: (threadId, content, sendOptions = {}) =>
        runtime.runPromise(
          sendMessage(threadId, content, sendOptions.retries === undefined ? {} : { retries: sendOptions.retries }),
        ) as Promise<RunOutcome>,
      messages: (threadId) =>
        withStore((s) => s.getMessages(threadId, { order: "asc", includeSilent: true })).then(
          (result) => result.messages,
        ),
      seed: (threadId, messages) => withStore((s) => s.appendMessages(threadId, messages)).then(() => undefined),
      close: async () => {
        await runtime.dispose()
        await reader.dispose()
        await Effect.runPromise(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            yield* fs.remove(dir, { recursive: true })
          }).pipe(Effect.provide(PlatformLive)),
        )
      },
    }
  },
}
