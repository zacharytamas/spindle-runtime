BLOCKS: 0. SHOULD FIX: 3.

# Review of PR 16, `m1/13-cli` at `7eeb9ef`, against `89c70bb`

Reviewer: Claude Opus 5.5. I read and ran everything below myself. I used no helper agents. Files are cited at the head commit unless a line says "base". Scripts, transcripts and results are under `/tmp/structure/review-6/`. The machine's load average stayed between 2 and 9 for the whole session, so no timing here was taken above 10.

Setup: `git fetch origin`, `git checkout --detach 7eeb9ef5e28e9af38fcceca6be3cc9b69bb1a84b`, then `git archive` of base and head into `/tmp/structure/review-6/base` and `/head`. A frozen install and a build passed in all three trees (`setup.summary`). Node 22.22.3 and Bun 1.4.5. No real model was called; every run used the audit's gated model or `--script`.

## BLOCKS

None. Apart from the two stated changes, I found one more visible change, in `recover`, and I marked it SHOULD FIX, not BLOCKS. The reason is under SHOULD FIX 1. If you apply your list literally it is a third change, and you may want to raise it.

Things I checked that come close and do not block:

- A line typed within half a millisecond of a Ctrl-C is echoed, never stored, and gets no note. That is a lost line. It happens at base at the same rate, and only at delays a keyboard cannot produce (`li-*.log`, table below). It is not new, so I did not block this PR on it. It is listed under Notes.
- Two or three interrupts 0.5 to 2 ms apart, at the prompt or behind a holder, sometimes end the chat with 130 or with death by the signal instead of 0. Both builds do this, all three exit outcomes occur at both, and the resume line printed in every such session I ran, at both builds. This is audit follow-up 12. The mix of outcomes shifted on Node (Notes).

## Point 1. What I drove, and what differed

`audit/drive.py` holds 189 scenarios. `audit/runall.py` ran each at base and head, on Node and Bun, twice, each in its own process group under a hard limit. That is 1,496 runs and about 3,500 command invocations. `audit/compare.py` normalizes ids, pids, paths and times, and compares standard output, standard error, the exit code, and a dump of the stored threads, messages and queue. The racy cases ran 8 to 10 more times per build (`r2`, `audit/dist.py`). The audit's own scripts t07, t09, t04 `chat2` and t11 `behind` ran unchanged at both builds on both runtimes (`stoch/`).

| Area | What I drove | Result |
|---|---|---|
| `run` | Reply with and without `--db`, tool call, tool error with a secret (throw, error, ok), provider failure, `--trace --dump-requests`, scripted replies, 6 bad scripts, 13 numbers in each of `statusCode` and `retryAfter`, `--hook-timeout` 0, -1, 0.001, abc, 1e400, 9 start failures (unknown agent, no agents dir, missing dir, duplicate name, both sides human, warnings only, `--db` a directory, in a missing directory, not a database) | Identical, except that `1e309`, `1e400` and `-1e400` in either field are now rejected (stated change). `0`, `-0`, `-1`, `2.75`, `500`, `1E2`, `1e308`, `-1e308`, `1e-400` and a 30-digit integer behave the same. |
| `run` signals | SIGINT once, twice, three times, twice with no gap, SIGTERM, SIGHUP, at validation, model call, model call that ignores the abort, tool, tool that watches the abort, hook | Identical on both runtimes. Twice with no gap is racy at both builds; every head outcome also occurred at base except one Bun run where only one of two back-to-back signals was delivered (a coalescing outcome that base produced on Node). |
| `send` | Send to an idle thread, missing thread, new file, missing dir, directory, garbage file, `--hook-timeout 0`, provider failure, behind a holder then released, behind a holder with SIGINT and with SIGTERM, to a terminated thread, SIGINT once and twice during a tool | Identical, including the waiting line and the still-queued note. |
| `status` | Idle, missing thread, directory, missing dir, garbage, new file, a dead holder (settled as lost), `threads`, `holders` and `messages` tables broken | Identical. |
| `recover` | Idle, missing thread, directory, missing dir, garbage, dead holder, live holder with and without `--force`, broken tables with and without `--force` | Identical except the broken `threads` and `holders` tables: base printed a stack trace on standard output, head prints `spindle: Failed to prepare statement` on standard error. Exit 1 at both. SHOULD FIX 1. |
| `validate` | The audit fixture with `--json` and `--list`, an empty project, a missing directory, a file, an unreadable directory, 40 invalid fixtures | Identical. Base already reported each of these as issues, so head's new error wrapper changes nothing visible. |
| Top level | `--help`, `--version`, no command, unknown command, `chat --help`, `run` with no agent, `send` with no `--db` | Identical. |
| Chat output contract O1 to O16 | Piped session with blank, padded, control and bidi characters, tool calls, errors, provider failure; a burst of lines; secrets in every position; `--trace --dump-requests`; `--full-results` and a 450-character result; no `--db`; `--script`; resume, missing, wrong agent, no `--db`, new file; terminated thread; seeded thread with a silent message; start failures; end of input mid-run and mid-line; `/dev/null` as input; standard error closed | Identical on both runtimes. |
| Chat signals | SIGINT once, twice, three times spaced, three with no gap, SIGTERM, SIGHUP, and SIGINT then SIGTERM, at validation, while the thread opens, at the first prompt, at a later prompt, model call, deaf model call, tool, watching tool, hook, and a line waiting behind another process (70 scenarios); abort then a line behind a deaf tool, a watching tool, a hook; abort then end of input; two consecutive aborts; Ctrl-C during a tool that blocks the JavaScript thread, once, twice, three times | Identical, except the zero-gap triples, which vary at both builds. In 10 runs each, every head outcome also occurred at base (three of them only on the other runtime) except one Node case under 8-way load (behind a holder, 9 of 10 head runs exited 130 where base exited 0). A quieter map of that case (`wb3-*.log`) shows the same window at both builds, 0.5 to 2 ms, with 0, 130 and death by the signal at both. The resume line and the queued note printed in every run. |
| Chat, other processes | `spindle send` at the prompt and in a run, a second chat at the prompt and with one waiting behind the other, the holder killed while a line waits, `recover --force` at the prompt, in a tool, in a model call, terminate at the prompt, at end of input, by the chat's own tool, and before a blank line | Identical. |
| Chat, database | File deleted at the prompt then end of input, deleted then a line, locked at start, at a send, during a tool result, during a model reply, at exit | Identical. Both say "the line was sent, but the run could not finish" for the locks during a run. |
| Chat, output | Reader closes at the prompt then a line, at the prompt then end of input, during a model call, during a tool, before a call line is written, during a tool with Ctrl-C; stalled reader with one interrupt, two interrupts, end of input, SIGTERM | Identical except the stalled reader with two interrupts: base prints the 150 KB reply twice, head once, and standard error is identical (stated change). With one interrupt, with end of input and with SIGTERM (20 runs), base and head print the same transcript: the typed line's echo and the reply, once each. |
| Pseudo-terminal | Ctrl-D, Ctrl-C at the prompt, two Ctrl-C in a watching tool then a line then Ctrl-C, three Ctrl-C in a deaf tool, SIGHUP in a tool, SIGTERM at the prompt, typing ahead during a tool | Identical. Terminal attributes were the same before and after in all 56 runs. |
| Audit scripts | t07 (48 line and Ctrl-C races, 84 double and triple Ctrl-C at the prompt, 28 triple Ctrl-C in a tool, hook abort, F17, F18, busy tool), t09 (160 double Ctrl-C at the prompt), t04 `chat2` (3 pairs and a 20-round race), t11 `behind` (250 rounds) | Same outcome classes at both builds. t11: no record printed twice, none missing, at both. t04: no line shown twice at either; base Node missed one other-side line once (`p19`), head never did. t09 resume line in 160 of 160 at all four. |

Racy distributions, base against head:

| Case | Node base | Node head | Bun base | Bun head |
|---|---|---|---|---|
| t09, two Ctrl-C at the prompt 0.1 to 3 ms apart, exit 0 / 130 / killed by SIGINT | 111 / 17 / 32 | 80 / 20 / 60 | 121 / 39 / 0 | 109 / 49 / 2 |
| Line then Ctrl-C after 0 or 0.5 ms (20 runs): stored / queued with note / not sent and no note | 1 / 15 / 4 | 4 / 12 / 4 | 1 / 9 / 10 | 9 / 1 / 10 |
| Line then Ctrl-C after 1 ms or more (60 runs) | all stored | all stored | all stored | all stored |
| Ctrl-C then SIGTERM at the prompt, 0 to 20 ms (36 runs) | resume line 36 of 36 | 36 of 36 | 36 of 36 | 36 of 36 |

The two stated changes check out. The stalled reader prints the reply once at head and twice at base, on both runtimes, and nothing else in that transcript differs. Only an overflowing exponent is read differently in a script.

## Point 2. Is the chat's loop what it claims to be?

Mostly yes. Every write to the cursor, the admission set, the held-over report and the phase happens in the one consumer fiber, `converse` at `packages/runtime/src/cli/chat.ts:141-306`. Producers only offer events. `onAdmitted` offers synchronously (`chat.ts:201-203`) so its event always precedes the same send's `waiting`, `record` and `done`. A send's completion carries its fiber (`chat.ts:207`, `:253`), so a superseded turn is ignored. `observe` waits for its acknowledgement or for the loop's end (`chat.ts:168-173`), so an execution never blocks on a consumer that has gone. The exit check drains admissions that were still in the queue (`chat.ts:347`), which is why a line admitted while a signal ends the loop still gets O13.

The orderings I tried to build:

- A signal between an admission and its event. Not possible as an ordering fault: the admitted event is enqueued in the same synchronous step as the commit, before the signal's event can be. A signal before the admission ends the chat with "not sent" and no note at both builds; that is the half-millisecond loss above.
- A record after its run was reported. A send's `done` follows its execution's settlement, and the execution awaits every acknowledgement before it settles, so a record of that run cannot arrive after `done`. A successor that inherits the observer reports through the next send.
- A deadlock between `finishPrevious` and an observation. I looked for one because `record` calls `finishPrevious` (`chat.ts:242`), which awaits the aborted run's settlement. An aborted run writes its closing records through the store (`Execution.ts:150-160`), not the observer, so it never waits on the consumer.
- An interrupt during the final drain. The exit region runs masked after the subscription closed, so the signal interrupts main after the resume line. That is follow-up 12 and unchanged.
- An event in a phase that drops it. `waiting` is dropped outside running and waiting (`chat.ts:216`). In one constructed case it matters: after an abort, another process queues a message, the abort settles and a successor runs that message in this process, the person types a line, and a Ctrl-C lands before the waiting event is handled. Base printed O11 and treated the next Ctrl-C as exit; head aborts the successor. I did not run it. It needs a Ctrl-C inside a window of a few microseconds.
- A producer that outlives its phase. The prompt's reader is the only one that can, and it ends at the scope. Stale `settled`, `done` and `poll` events are filtered by identity or phase.
- A queue that grows while the consumer waits on a write. Yes, the remote poll. SHOULD FIX 2, witnessed.

A gated test settled one more doubt: two commands in one process. See point 3.

## Point 3. The terminal, and handlers after a scope closes

The chat never changes the terminal's mode, and the attributes matched before and after all 56 pseudo-terminal runs at both builds, after Ctrl-D, Ctrl-C at the prompt and in tools, SIGHUP, SIGTERM and typing ahead.

For the handlers I wrote `interrupts.test.ts` (copy in this directory; it ran from `head/packages/runtime/test/review/`). It runs two `spindle run` commands in one process with `Command.runWith`, gated on the fixture's files and on printed notes, never on a delay. It passes on Node and on Bun (`interrupts-node.log`, `interrupts-bun.log`):

- A run holding a tool adds exactly one SIGINT listener. After its second interrupt the listener is gone, before the run returns. After it returns the count is back to where it started.
- The second run adds one listener, shows no stop or abort note before its own interrupt, takes one interrupt as one stop, and leaves no listener behind.
- Three interrupts emitted in one turn into the first run: it stops and aborts, the third is absorbed by its closing queue, and the second command sees none of them.

## Point 4. Is it the simpler shape?

Partly. The counts are as claimed: the command line went from 923 to 860 lines, `run.ts` from 294 to 121, `shared.ts` is 164, all runtime source from 8,696 to 8,625. The shape follows the quality review's sketch (`/tmp/quality-review/pr-10.md`, S1 to S5) closely.

`shared.ts` is one thing: what a command needs to start, print and fail. Every export has at least two callers. The only drawer-like part is three one-line formatters (`shared.ts:18-21`), and they are small enough to leave. Its weak spot is `withProject` (`shared.ts:119-164`): seven positional parameters, one of them used only by `run` (`observer`), a target type with a chat-only flag (`resume`, `shared.ts:122`) and a chat-only rule inside it (`--thread needs --db`, `shared.ts:148`). That is the shared function learning each caller's exceptions.

`converse` is 166 lines against base's 160. It is still one function, and it still holds the terminal wiring, the transcript cursor, the observer bridge, the sends, the Ctrl-C machine, the remote poll and the held-over report. The difference is that they are now cases of one switch over one queue, with one owner of state, which is what removed the ordering faults. The quality review estimated about 175 lines for this loop, so the size is what was asked for. The review also estimated `chat.ts` at about 290 lines; it is 369. I could not find where a different cut would save the difference. The remaining length is `openThread` (43 lines, unchanged), the exit summary (30), `messageLines` and `report` (30), and the event and phase types (25).

What can be deleted, with lines:

- `Execution.settlement.isDone` (`packages/runtime/src/execution/Execution.ts:56`) is now read only by `test/execution/settlement.test.ts:62`. SHOULD FIX 3.
- The thread check is written twice: `open` at `chat.ts:160` and again at `chat.ts:351-353`. The exit can call `open`. Two lines.
- `requireOpen` (`chat.ts:66-69`) then has one caller besides `open` (`openThread`, `chat.ts:97`); it can stay.
- Moving `--thread needs --db` from `shared.ts:148` to `chat.ts` removes `resume` from the shared target type. It would run before the project's modules load, which changes nothing a person sees unless a module prints at import. One or two lines.

I found no block of more than a few lines that can go.

## Point 5. Effect usage

`pnpm exec effect-tsgo tsc --noEmit -p tsconfig.json` at head exits 0 and reports two suggestions, both `tryCatchInEffectGen` in `packages/runtime/src/registry/validate.ts:525` and `:584`, a file this PR does not touch. Nothing for the touched files (`tsgo-head.log`).

I checked against `node_modules/effect/dist`:

- `Effect.raceFirst` resumes with whichever side exits first, including an interrupt (`internal/effect.js:1188-1214`). So `run`'s `Effect.interrupt` when nothing can be stopped (`run.ts:104`, `:107`) ends the command as base's `interruptUnsafe` of the main fiber did.
- `Effect.forkScoped` schedules the child on the parent's dispatcher, not at once (`internal/effect.js:2492-2507`). The send therefore starts in a later turn at both builds, which is the source of the half-millisecond loss.
- `Queue.make` takes the creating fiber's dispatcher (`Queue.js:187`), and a fiber drops its cached dispatcher when the provided scheduler changes (`internal/effect.js:585-586`). So `Effect.provideService(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"))` around `Queue.make` (`chat.ts:339-341`) does give the queue microtask wake-ups, as the comment says. `Queue.dispatcher` is a public field (`Queue.d.ts:161`) and `MixedScheduler` with `"sync"` is a public constructor (`Scheduler.d.ts:109-112`). This is correct, but it exists to keep one base quirk: a Ctrl-C pressed during a tool that blocks the JavaScript thread lands at the prompt after the reply and ends the chat. Note.
- `Context.Reference` with `defaultValue` (`Context.d.ts:1741`), `Fiber.addObserver` (`Fiber.d.ts:83`), `Effect.acquireRelease` in `listen`, `Effect.uninterruptibleMask` with `restore` around the loop only, and `Deferred` for acknowledgements are all ordinary uses.
- `chat.ts:261-262` still uses `Cause.squash` and `instanceof ThreadTerminated`. `send`'s error channel is now typed (`ThreadSupervisor.ts:57`), so a tag check on the failure would do. Note.

## SHOULD FIX

**1. The PR's Scope says only two things a user can see changed. `recover` is a third.** With a broken `threads` or `holders` table, base printed the runtime's stack trace on standard output and head prints one line, `spindle: Failed to prepare statement` on Node or `spindle: Failed to execute statement` on Bun, on standard error. Both exit 1. Witness: `recover_cases`, parts `broken_threads`, `broken_threads_force`, `broken_holders`, `broken_holders_force`, at `r1/recover_cases.{base,head}.{node,bun}.*.json`, run with `python3 audit/runall.py <dir> 8 2 base,head node,bun '^recover_cases$'` and compared with `audit/keys.py`. Lines: `packages/runtime/src/cli/status.ts:70` adds `commandErrors()`; base `status.ts:57-78` had no handler. The change was asked for (`/tmp/quality-review/pr-10.md:119-120`), it is an improvement, and "What changed" in the PR body names it, so I did not block. The Scope paragraph ("Every other line a command prints, its stream, and its exit code are unchanged") is wrong. Smallest fix: add a third bullet to Scope. The one line also drops SQLite's reason (`no such table: holders`) that base's trace showed; `status` already behaved that way at base.

**2. The remote poll grows the chat's queue without bound while the chat is blocked writing.** `chat.ts:224-227` forks `Effect.forever(sleep 50 ms, offer poll)`. The offer never waits, so while the consumer is stuck in a write to a stalled reader during a remote wait, poll events pile up at 20 a second. Base's poller called `flush` under the semaphore and blocked with the writer, so it could not pile up. Witness: `audit/w_poll.py` with an instrumented copy of head's build (`head/packages/runtime/dist-instr`, one line that logs the queue size after each take). Chat B waits behind chat A, a third process queues a 200 KB line, and B's reader stalls. The largest backlog after a take was 18 for a 1 s stall, 56 for 3 s, 114 for 6 s, almost all `poll`. Run: `AUDIT_MAIN=/tmp/structure/review-6/head/packages/runtime/dist-instr/cli/main.js AUDIT_RUNTIME=node python3 audit/w_poll.py 6`. Nothing prints differently and the backlog drains in a burst of reads, so this is not a block. Smallest fix: let the consumer schedule each poll. Fork one `Effect.delay(offer({ kind: "poll" }), "50 millis")` when the wait begins and another at the end of `case "poll"`. At most one poll is then outstanding, and the `Effect.forever` goes.

**3. `settlement.isDone` is kept only for a test.** `packages/runtime/src/execution/Execution.ts:56`. The chat no longer calls it, and the only reader is `packages/runtime/test/execution/settlement.test.ts:62`, which checks that the abort returns before the run settles. Smallest fix: delete the method, and in the test fork `settlement.await` and check that the fiber has not finished (`Fiber.pollUnsafe`), or race it against `Effect.yieldNow`.

## Notes

- A line typed within 0.5 ms of a Ctrl-C is echoed and then neither sent nor reported, at base and head alike (`li-*.log`): Node 4 of 20 at both, Bun 10 of 20 at both. From 1 ms on, every line was stored. Pre-existing, and not reachable from a keyboard.
- t09 on Node shifted toward death by SIGINT after the resume line: head 60 of 160, base 32 of 160. Same outcome classes and same window as audit follow-up 12; the resume line printed in all 640 sessions across the four builds.
- Three interrupts in one event-loop turn: the run's second one closes the subscription and the third is absorbed by the dying queue (`interrupts.test.ts`, second case). With real signals the kernel usually merges such a burst anyway.
- `runMain` now broadcasts SIGINT to every open subscription (`packages/runtime/src/platform/interrupts.ts:21`), where base gave it only to the last handler registered. No command opens two today.
- The default `Interrupts` subscribes to `process` directly (`interrupts.ts:15`). A command run in-process, as the tests do, suppresses Node's default exit on Ctrl-C while its scope is open.
- `withProject` (`shared.ts:119-127`) would read better with one options object than with seven positional parameters.
- `finish` is a function declaration after the infinite loop (`chat.ts:298-305`) and relies on hoisting.
- The scheduler trick at `chat.ts:338-341` keeps a base quirk alive: a Ctrl-C during a tool that blocks the JavaScript thread ends the chat after the reply instead of stopping the run. Worth a follow-up row if the quirk is not wanted.
- At base on Node, t04's 20-round race once missed an other-side line (`p19`); head never did. One sample, not investigated.
- `run`'s `onWaiting` ignores local holders (`run.ts:61-64`), which matches base, where the `queued` event fired only for a remote holder.
- The commit message of `7eeb9ef` and the plan's appendix describe the scheduler change accurately.

## Process check

At the end I listed every process whose command line held `/tmp/structure/review-6` or the worktree path with `ps -axo pid=,ppid=,etime=,command=`. The only two matches were this review session's own `claude` process and its shell wrapper, which carry the worktree path in their arguments. No `node`, `bun`, `python3`, `spindle` or `sleep` process of mine was left, so there was nothing to kill. `git status` in the worktree is clean and HEAD is detached at `7eeb9ef5e28e9af38fcceca6be3cc9b69bb1a84b`. The base and head copies, the instrumented build and the added test live only under `/tmp/structure/review-6/`.
