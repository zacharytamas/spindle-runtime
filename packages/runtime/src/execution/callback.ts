import type { Execution } from "./Execution.ts"

export type PendingCallbacks = Pick<Execution, "track" | "forget">

export class Callback {
  #finished = false
  #expired = false
  #promise?: Promise<unknown>

  get finished() {
    return this.#finished
  }
  get expired() {
    return this.#expired
  }

  expire(pending: PendingCallbacks | undefined) {
    this.#expired = true
    if (this.#promise) pending?.forget(this.#promise)
  }

  invoke<A>(pending: PendingCallbacks | undefined, operation: string, invoke: () => PromiseLike<A> | A) {
    try {
      const value = invoke()
      if (!value || typeof (value as PromiseLike<A>).then !== "function") {
        this.#finished = true
        return Promise.resolve(value)
      }
      const result = Promise.resolve(value).finally(() => {
        this.#finished = true
        pending?.forget(result)
      })
      this.#promise = result
      pending?.track(result, operation)
      return result
    } catch (error) {
      this.#finished = true
      throw error
    }
  }
}
