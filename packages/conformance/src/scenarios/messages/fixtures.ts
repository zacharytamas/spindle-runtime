export const contents = (messages: ReadonlyArray<{ readonly content?: unknown }>) => messages.map((m) => m.content)
