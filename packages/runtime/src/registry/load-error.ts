import { Data, Effect, type Path } from "effect"
import type { Definition, Issue } from "./definition.ts"

export type ImportFile = (
  file: string,
  url: ReturnType<Path.Path["toFileUrl"]>,
) => Effect.Effect<Record<string, unknown>, LoadError>

export interface Discovered extends Omit<Definition, "value"> {
  readonly load: Effect.Effect<unknown, LoadError>
}

export class LoadError extends Data.TaggedError("LoadError")<{ readonly issues: ReadonlyArray<Issue> }> {}

const TYPESCRIPT_SYNTAX =
  "The file uses TypeScript syntax that Node cannot strip, such as an enum, a namespace, or a constructor parameter property. Node removes type annotations but does not transform code. Rewrite it with erasable syntax, for example a union of string literals in place of an enum."
const NODE_MODULES_TYPESCRIPT =
  "The file is a TypeScript file inside node_modules, and Node does not strip types from files there. Publish the package as JavaScript."

export const describeCause = (cause: unknown): string => {
  try {
    const message = typeof cause === "object" && cause !== null ? Reflect.get(cause, "message") : undefined
    return typeof message === "string" ? message : String(cause)
  } catch {
    return "The thrown value cannot be printed."
  }
}

// Authored code can throw from a getter or a proxy trap wherever Spindle reads it, so a defect here becomes an issue.
export const reportDefects = <A, R>(
  load: Effect.Effect<A, LoadError, R>,
  definition: Pick<Definition, "kind" | "file" | "path">,
): Effect.Effect<A, LoadError, R> =>
  load.pipe(
    Effect.catchDefect((cause) =>
      Effect.fail(
        new LoadError({
          issues: [
            {
              code: "definition_load_failed",
              severity: "error",
              message: `The ${definition.kind} threw while Spindle loaded it. ${describeCause(cause)}`,
              file: definition.file,
              path: definition.path,
            },
          ],
        }),
      ),
    ),
  )

export const describeImportFailure = (cause: unknown): string => {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined
  if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") return TYPESCRIPT_SYNTAX
  if (code === "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING") return NODE_MODULES_TYPESCRIPT
  return `The file failed to load. ${describeCause(cause).split("\n")[0]}`
}

// The definition helpers in @standardagents/spec, such as defineAgent, throw one "<path>: <message>" line per issue.
const FIELD_LINE = /^([A-Za-z_$][\w$]*(?:\.[\w$]+|\[\d+\])*): (.+)$/

export const fieldIssues = (
  cause: unknown,
  location: { readonly file: string; readonly path: string },
  describe: (message: string) => string,
  whole: string,
): ReadonlyArray<Issue> => {
  const lines = describeCause(cause)
    .split("\n")
    .map((line) => FIELD_LINE.exec(line))
  const fields = lines.flatMap((match) => (match === null ? [] : [match]))
  const issue = (path: string, message: string): Issue => ({
    code: "definition_load_failed",
    severity: "error",
    message,
    file: location.file,
    path,
  })
  return fields.length === lines.length
    ? fields.map(([, field = "", message = ""]) =>
        issue([location.path, field].filter((part) => part !== "").join("."), describe(message)),
      )
    : [issue(location.path, whole)]
}
