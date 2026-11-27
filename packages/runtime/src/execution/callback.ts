export class Callback {
  #finished = false
  #expired = false
  #release: (() => void) | undefined

  get finished() {
    return this.#finished
  }
  get expired() {
    return this.#expired
  }

  expire() {
    this.#expired = true
    this.#release?.()
    this.#release = undefined
  }

  invoke<A>(invoke: () => PromiseLike<A> | A, register?: (promise: Promise<unknown>) => () => void) {
    try {
      const value = invoke()
      if (!value || typeof (value as PromiseLike<A>).then !== "function") {
        this.#finished = true
        return Promise.resolve(value)
      }
      const result = Promise.resolve(value).finally(() => {
        this.#finished = true
        this.#release?.()
        this.#release = undefined
      })
      this.#release = register?.(result)
      return result
    } catch (error) {
      this.#finished = true
      throw error
    }
  }
}
