export const parseJson = (text: string | undefined): unknown => {
  try {
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

export interface NotJson {
  readonly path: string
  readonly found: string
}

const maxJsonDepth = 1000

class Found implements NotJson {
  readonly path: string
  readonly found: string
  constructor(path: string, found: string) {
    this.path = path
    this.found = found
  }
}

// A thrown value with no prototype has no string form, and String throws for it.
const printed = (cause: unknown) => {
  try {
    return String(cause)
  } catch {
    return "a value that has no string form"
  }
}

const read = <A>(path: string, get: () => A): A => {
  try {
    return get()
  } catch (cause) {
    throw new Found(path, `a property that threw ${printed(cause)}`)
  }
}

// Builds the text from the same reads that validate it, so a value that changes between the check and
// the write cannot reach the database. JSON.stringify would drop or rewrite the values rejected here.
export const toJson = (value: unknown): string | NotJson => {
  const ancestors = new Set<object>()
  const write = (value: unknown, path: string): string => {
    switch (typeof value) {
      case "string":
        return JSON.stringify(value)
      case "boolean":
        return String(value)
      case "number":
        if (Number.isFinite(value)) return JSON.stringify(value)
        throw new Found(path, String(value))
      case "bigint":
        throw new Found(path, "a BigInt")
      case "object": {
        if (value === null) return "null"
        if (ancestors.has(value)) throw new Found(path, "a circular reference")
        if (ancestors.size === maxJsonDepth) throw new Found(path, `nesting deeper than ${maxJsonDepth} levels`)
        ancestors.add(value)
        let text: string
        if (Array.isArray(value)) {
          const items: Array<string> = []
          const length = read(path, () => value.length)
          for (let index = 0; index < length; index++)
            items.push(
              write(
                read(path, () => value[index]),
                `${path}[${index}]`,
              ),
            )
          text = `[${items.join(",")}]`
        } else {
          // A plain object has no prototype or one that has none itself, in whichever realm made it.
          // Anything else, such as a Date or a class instance, can serialize to a value that differs from its members.
          const prototype = read(path, () => Object.getPrototypeOf(value))
          if (prototype !== null && read(path, () => Object.getPrototypeOf(prototype)) !== null)
            throw new Found(path, `a ${read(path, () => prototype.constructor?.name) ?? "non-plain"} object`)
          const entries = read(path, () => Object.entries(value))
          const ownToJson = entries.find(([key]) => key === "toJSON")
          if (
            typeof (ownToJson ? ownToJson[1] : read(path, () => (value as { toJSON?: unknown }).toJSON)) === "function"
          )
            throw new Found(path, "an object with a toJSON method")
          const members: Array<string> = []
          for (const [key, member] of entries)
            if (member !== undefined) members.push(`${JSON.stringify(key)}:${write(member, `${path}.${key}`)}`)
          text = `{${members.join(",")}}`
        }
        ancestors.delete(value)
        return text
      }
      default:
        throw new Found(path, typeof value === "undefined" ? "undefined" : `a ${typeof value}`)
    }
  }
  try {
    return write(value, "$")
  } catch (error) {
    if (error instanceof Found) return { path: error.path, found: error.found }
    throw error
  }
}
