import { Argument, Command, Flag } from "effect/cli"
import { deliver } from "./run.ts"

import { deliveryFlags } from "./shared.ts"

export const sendCommand = Command.make(
  "send",
  {
    thread: Argument.String("thread").pipe(Argument.withDescription("The id of the thread that spindle run printed")),
    ...deliveryFlags,
    db: Flag.String("db").pipe(Flag.withDescription("The SQLite database file that holds the thread")),
  },
  (args) => deliver(args, { thread: args.thread }),
).pipe(
  Command.withDescription(
    "Send one message to a thread. An idle thread runs here, and a running thread takes it before its next model call.",
  ),
)
