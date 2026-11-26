import { Config, Effect, Option } from "effect"

export type EnvRecord = Readonly<Record<string, string>> | undefined

// The thread and user levels of Threads section 2.3 arrive with setEnv (M2) and users (later), so a lookup
// here walks agent, then the prompt's tool entry and the prompt, then the runtime instance.
export interface EnvScope {
  readonly agent: EnvRecord
  readonly toolEntry: EnvRecord
  readonly prompt: EnvRecord
}

// What an execution knows to be secret. A variable that a declaration or the provider config marks secret is
// secret whatever source its value comes from, and each secret value resolved so far is redacted.
export interface Secrets {
  readonly names: Set<string>
  readonly values: Set<string>
}

const own = (record: EnvRecord, name: string) =>
  record !== undefined && Object.hasOwn(record, name) && typeof record[name] === "string" ? record[name] : undefined

export const instanceEnv = (name: string): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    return Option.getOrUndefined(yield* Config.option(Config.String(name)))
  }).pipe(Effect.orElseSucceed(() => undefined))

export const resolveEnv = (scope: EnvScope, name: string): Effect.Effect<string | undefined> => {
  const declared = own(scope.agent, name) ?? own(scope.toolEntry, name) ?? own(scope.prompt, name)
  return declared === undefined ? instanceEnv(name) : Effect.succeed(declared)
}
