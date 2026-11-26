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

const STRING = /"(?:[^"\\]|\\.)*"/g
const KEY = /\s*:/y

const holdsJson = (text: string) => {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === "object" && value !== null
  } catch {
    return false
  }
}

// Text that holds a JSON object or array keeps its property names, numbers, and layout, and only its string
// values are redacted. A string value that changes is written as JSON again, so the text stays valid JSON.
export const redactText =
  (redact: (text: string) => string) =>
  (text: string): string => {
    if (!holdsJson(text)) return redact(text)
    return text.replace(STRING, (token: string, offset: number) => {
      KEY.lastIndex = offset + token.length
      if (KEY.test(text)) return token
      const value = JSON.parse(token) as string
      const redacted = redact(value)
      return redacted === value ? token : JSON.stringify(redacted)
    })
  }

const isPlain = (value: object) => {
  const prototype = Object.getPrototypeOf(value)
  return Array.isArray(value) || prototype === null || Object.getPrototypeOf(prototype) === null
}

// Rewrites every string in plain data. Keys change only when mapKey is given. Anything but plain data, a cycle
// included, is kept as it is, so that the store still rejects what JSON cannot represent.
export const mapStrings = <A>(
  value: A,
  map: (text: string) => string,
  mapKey: (key: string) => string = (key) => key,
): A => {
  const walk = (item: unknown, ancestors: Set<object>): unknown => {
    if (typeof item === "string") return map(item)
    if (typeof item !== "object" || item === null || ancestors.has(item) || !isPlain(item)) return item
    ancestors.add(item)
    const copy = Array.isArray(item)
      ? item.map((member) => walk(member, ancestors))
      : Object.fromEntries(Object.entries(item).map(([key, member]) => [mapKey(key), walk(member, ancestors)]))
    ancestors.delete(item)
    return copy
  }
  return walk(value, new Set()) as A
}
