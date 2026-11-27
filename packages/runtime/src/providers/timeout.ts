const UNDICI_TIMEOUTS = ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]

// Providers section 7.1: a request that timed out is retryable, whichever layer timed it out. AbortSignal.timeout
// raises a DOMException named TimeoutError, and Node's fetch puts its own connect, header, and body timeouts in the
// cause of the error it throws, so the chain of causes is searched.
export const isTimeout = (cause: unknown): boolean => {
  let error = cause
  for (let depth = 0; depth < 8 && typeof error === "object" && error !== null; depth++) {
    const { name, code } = error as { readonly name?: unknown; readonly code?: unknown }
    if (name === "TimeoutError" || code === "ETIMEDOUT" || UNDICI_TIMEOUTS.includes(code as string)) return true
    error = (error as { readonly cause?: unknown }).cause
  }
  return false
}
