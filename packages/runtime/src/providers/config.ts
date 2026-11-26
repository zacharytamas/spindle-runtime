import type {
  LLMProviderInterface,
  ModelDefinition,
  ProviderConfigSlot,
  ProviderFactoryConfig,
  ProviderFactoryWithOptions,
  ThreadState,
} from "@standardagents/spec"
import { Effect } from "effect"
import { FetchHttpClient } from "effect/http"
import { addSecret, instanceEnv, type Secrets } from "../execution/env.ts"
import { type Loaded, SetupError } from "../execution/turn.ts"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isSource = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && ((value.type === "env" && typeof value.name === "string") || value.type === "const")

const coerce = (value: unknown, type: unknown) => {
  if (typeof value !== "string") return value
  if (type === "number" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
  if (type === "boolean" && (value === "true" || value === "false")) return value === "true"
  return value
}

interface Resolution {
  readonly missing: Array<string>
  readonly secrets: Secrets
}

const learn = (found: Resolution, name: string | undefined, value: unknown) => {
  if (name !== undefined) found.secrets.names.add(name)
  if (typeof value === "string") addSecret(found.secrets, value)
}

const fromSlot = Effect.fn("fromSlot")(function* (key: string, slot: ProviderConfigSlot, found: Resolution) {
  const value = (slot.defaultEnv === undefined ? undefined : yield* instanceEnv(slot.defaultEnv)) ?? slot.default
  if (value === undefined && slot.required === true) found.missing.push(slot.defaultEnv ?? key)
  if (slot.type === "secret") learn(found, slot.defaultEnv, value)
  return coerce(value, slot.type)
})

// Providers section 1.3, Config Slots: an extension's value source wins, then the base slot's defaultEnv, then
// its default. A nested map resolves leaf by leaf, and a leaf with no value is left out.
const fromSource = (source: unknown, slot: ProviderConfigSlot | undefined, found: Resolution): Effect.Effect<unknown> =>
  Effect.gen(function* () {
    if (isSource(source)) {
      if (source.type === "const") {
        if (slot?.type === "secret") learn(found, undefined, source.value)
        return source.value
      }
      const name = String(source.name)
      const value = (yield* instanceEnv(name)) ?? source.default
      const required = typeof source.required === "boolean" ? source.required : slot?.required === true
      if (value === undefined && required) found.missing.push(name)
      const type = source.valueType ?? slot?.type
      if (source.valueType === "secret" || slot?.type === "secret") learn(found, name, value)
      return coerce(value, type)
    }
    if (!isRecord(source)) {
      if (slot?.type === "secret") learn(found, undefined, source)
      return source
    }
    const map: Record<string, unknown> = {}
    for (const [key, leaf] of Object.entries(source)) {
      const value = yield* fromSource(leaf, undefined, found)
      if (value !== undefined) map[key] = value
    }
    return map
  })

const isProvider = (value: unknown): value is LLMProviderInterface =>
  isRecord(value) && typeof value.stream === "function" && typeof value.generate === "function"

export const resolveConfig = Effect.fn("resolveConfig")(function* (model: Loaded<ModelDefinition>, secrets: Secrets) {
  const factory = model.value.provider as ProviderFactoryWithOptions
  const slots = factory.configSlots ?? {}
  const sources: Record<string, unknown> = factory.providerDefinition?.config ?? {}
  const found: Resolution = { missing: [], secrets }
  const config: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(slots), ...Object.keys(sources)])) {
    const slot = slots[key]
    const value =
      sources[key] !== undefined
        ? yield* fromSource(sources[key], slot, found)
        : slot === undefined
          ? undefined
          : yield* fromSlot(key, slot, found)
    if (value !== undefined) config[key] = value
  }
  return { config, missing: found.missing }
})

// Returns the effect that yields the provider for one request. A missing required value fails here, before any
// request. An extension that declares createFetch is built again for each request, with that request's transport.
export const providerFor = Effect.fn("providerFor")(
  (model: Loaded<ModelDefinition>, state: ThreadState, secrets: Secrets) =>
    Effect.flatMap(resolveConfig(model, secrets), ({ config, missing }) => {
      const factory = model.value.provider as ProviderFactoryWithOptions
      const definition = factory.providerDefinition
      const name = model.definition.qualifiedName
      if (missing.length > 0)
        return Effect.fail(
          new SetupError({
            message: `The provider of model ${name} needs ${missing.join(", ")}, which ${missing.length === 1 ? "has" : "have"} no value`,
          }),
        )
      return Effect.flatMap(FetchHttpClient.Fetch, (transport) => {
        const resolved: ProviderFactoryConfig = {
          ...config,
          apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
        }
        const build = Effect.try({
          try: () => {
            const fetch =
              definition?.createFetch === undefined
                ? transport
                : definition.createFetch({ providerName: definition.name, config: resolved, state })
            const instance: unknown = factory({ ...resolved, fetch }, { state })
            if (!isProvider(instance)) throw new Error("it did not return an object with generate and stream methods")
            return instance
          },
          catch: (cause) =>
            new SetupError({
              message: `The provider factory of model ${name} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
            }),
        })
        return definition?.createFetch === undefined ? Effect.map(build, Effect.succeed) : Effect.succeed(build)
      })
    }),
)
