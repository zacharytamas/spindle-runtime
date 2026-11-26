import { Effect } from "effect"

export const processAlive = (pid: number) =>
  Effect.suspend(() => {
    try {
      process.kill(pid, 0)
      return Effect.succeed(true)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ESRCH") return Effect.succeed(false)
      if (code === "EPERM") return Effect.succeed(true)
      return Effect.as(Effect.logWarning(`Could not probe process ${pid}: ${String(error)}`), true)
    }
  })
