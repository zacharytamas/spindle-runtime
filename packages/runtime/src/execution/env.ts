import { Config, Effect, Option } from "effect"
import { SetupError } from "./turn.ts"

export type EnvRecord = Readonly<Record<string, string>> | undefined

// The thread and user levels of Threads section 2.3 arrive with setEnv (M2) and users (later), so a lookup
// here walks agent, then the prompt's tool entry and the prompt, then the runtime instance.
export interface EnvScope {
  readonly agent: EnvRecord
  readonly toolEntry: EnvRecord
  readonly prompt: EnvRecord
}

export interface Resolved {
  readonly value: string
  // Threads section 2.3 makes a source other than the thread secret by default. A definition default is text
  // that the developer wrote, so its declaration classifies it. The instance environment belongs to the operator,
  // and nothing in a definition can vouch for it, so its every value is secret.
  readonly fromInstance: boolean
}

// What an execution knows to be secret. A variable that a declaration or the provider config marks secret is
// secret whatever source its value comes from. Every value a tool reads is redacted, and the system prompt may
// hold none of the values in barred, which are the ones a secret name or the instance environment supplied.
export interface Secrets {
  readonly names: Set<string>
  readonly values: Set<string>
  readonly barred: Set<string>
}

export const newSecrets = (values: Set<string> = new Set()): Secrets => ({
  names: new Set(),
  values,
  barred: new Set(),
})

export const addSecret = (secrets: Secrets, value: string) => {
  secrets.values.add(value)
  secrets.barred.add(value)
}

const own = (record: EnvRecord, name: string) =>
  record !== undefined && Object.hasOwn(record, name) && typeof record[name] === "string" ? record[name] : undefined

export const instanceEnv = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.mapError(() => new SetupError({ message: `Instance environment read failed for ${name}` })),
  )

export const lookupEnv = (scope: EnvScope, name: string): Effect.Effect<Resolved | undefined, SetupError> => {
  const declared = own(scope.agent, name) ?? own(scope.toolEntry, name) ?? own(scope.prompt, name)
  if (declared !== undefined) return Effect.succeed({ value: declared, fromInstance: false })
  return Effect.map(instanceEnv(name), (value) => (value === undefined ? undefined : { value, fromInstance: true }))
}

export const resolveEnv = (scope: EnvScope, name: string): Effect.Effect<string | undefined, SetupError> =>
  Effect.map(lookupEnv(scope, name), (found) => found?.value)

// A definition may hide an instance value. Both remain secret when user code writes them.
export const learnVariable = Effect.fnUntraced(function* (scope: EnvScope, name: string, secrets: Secrets) {
  const found = yield* Effect.orElseSucceed(lookupEnv(scope, name), () => undefined)
  if (found && (found.fromInstance || secrets.names.has(name))) addSecret(secrets, found.value)
  const instance = yield* Effect.orElseSucceed(instanceEnv(name), () => undefined)
  if (instance !== undefined) addSecret(secrets, instance)
})
