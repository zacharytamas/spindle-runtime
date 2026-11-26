export const REDACTED = "[redacted]"

// Threads section 2.3: secret values are redacted from tool output and logs. Serialized text holds a value in
// its JSON-escaped form too, and a longer secret goes first so that a shorter one inside it cannot split it.
export const redactor = (secrets: ReadonlySet<string>) => (text: string) => {
  let redacted = text
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret === "") continue
    redacted = redacted.replaceAll(secret, REDACTED)
    const escaped = JSON.stringify(secret).slice(1, -1)
    if (escaped !== secret) redacted = redacted.replaceAll(escaped, REDACTED)
  }
  return redacted
}

const isPlain = (value: object) => {
  const prototype = Object.getPrototypeOf(value)
  return Array.isArray(value) || prototype === null || Object.getPrototypeOf(prototype) === null
}

// Anything but plain data, a cycle included, is kept as it is, so that the store still rejects what JSON cannot
// represent.
export const redactDeep = <A>(redact: (text: string) => string, value: A): A => {
  const walk = (item: unknown, ancestors: Set<object>): unknown => {
    if (typeof item === "string") return redact(item)
    if (typeof item !== "object" || item === null || ancestors.has(item) || !isPlain(item)) return item
    ancestors.add(item)
    const copy = Array.isArray(item)
      ? item.map((member) => walk(member, ancestors))
      : Object.fromEntries(Object.entries(item).map(([key, member]) => [key, walk(member, ancestors)]))
    ancestors.delete(item)
    return copy
  }
  try {
    return walk(value, new Set()) as A
  } catch {
    return value
  }
}
