export interface Callback {
  finished?: boolean
  promise?: Promise<unknown>
}

export const invokeCallback = <A>(
  callback: Callback,
  pending: Set<Promise<unknown>> | undefined,
  invoke: () => PromiseLike<A> | A,
) => {
  try {
    const value = invoke()
    if (!value || typeof (value as PromiseLike<A>).then !== "function") {
      callback.finished = true
      return Promise.resolve(value)
    }
    const result = Promise.resolve(value).finally(() => {
      callback.finished = true
      pending?.delete(result)
    })
    pending?.add(result)
    callback.promise = result
    return result
  } catch (error) {
    callback.finished = true
    throw error
  }
}
