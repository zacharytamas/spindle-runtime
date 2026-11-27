# Milestone 1 follow-ups

This file lists what the audits and verifiers of milestone 1 found and what the root deferred. Each item names the PR that takes it. The root removes an item when a test proves it fixed.

## M1-5, hooks

- Fixed in the M1-5 fix round. A secret is now replaced everywhere in text that a tool or a hook wrote, property names included.
- A request hook can put a secret into a message of a role other than system, and the provider receives it. The developer's hook wrote that text. This is a documented limit, not a defect.
- On a long thread, request assembly walks every stored message at every step, and each `filter_messages` hook gets a deep copy of the whole snapshot, which takes 8 ms at 5,000 messages.

## M1-6, queues and one execution per thread

The owner built M1-6 at `9f8429a`, and the root merged M1-5 into it at `ad3578c`. The verifier and two audits are running. Each item below says whether the build claims it.

Built, and waiting for the verifier or an audit to confirm.

- The stored run state now settles to `idle` or `failed` after a failure, and a killed process's thread reads `failed execution_lost`.
- An unanswered tool call gets an error result at recovery, and no tool is replayed.
- `NaN` or `Infinity` as `retries` is rejected.
- A thread state that a tool kept after its run ended refuses every call with a typed error.
- A hook that a tool's `injectMessage` started ends when terminate aborts the run.

For the fix round.

- Dead-holder detection uses silence alone, a 15 second lease renewed five times per lease. The root's rule replaces it. A holder whose process is gone is dead at once. A live holder is never taken over for being slow. Silence past a threshold is the fallback, and every write from the stale holder is then refused.
- Only message writes are fenced against a stale holder. A `setValue` can still land.
- `store.setStatus` and `takeQueue` still exist and bypass the transition table and the claims. `takeQueue` deletes the batch it hands out.
- Queued work can carry one execution past the step cap. When a step reaches the cap and a higher-ranked stop rule also applies, such as `stop_on_response`, the loop continues if the queue holds work. A hook that queues a message on every response then runs without end. The review bot found this on PR 8 at `step.ts:651`, and the root confirmed it by reading. The fix is to check the step count on its own when deciding whether to continue.
- A `send` that waited behind a run exits 0 and prints `idle (aborted)` when another process terminates the thread, and its message stays queued for good. Reading 7 says its claim fails with `ThreadTerminated`. The verifier saw this in 16 of 16 races on each runtime.
- A process that lost its thread prints a success outcome and exits 0.
- The error text on a call that never started says Spindle does not know whether the tool finished. For a call that never started, that is untrue.
- `supervisor.abort` releases the thread while a tool that ignores the signal may still run. Only `spindle run` uses it today, and that command exits right after.

Open, not for this round.

- A tool that never returns has no deadline, and nothing can stop it.
- A model stream that stalls waits forever when the model sets no timeout.
- `invokeTool` on a thread at rest returns an error result. The brief suggested a minimal execution, which needs a decision on run status and claims.
- The step is about 0.1 ms slower than its parent on Node, and 0.07 ms of that is not explained.
- The planned threads rows still owe a test of each ThreadState member.
- Cleanup on interrupt was incomplete before M1-6. The owner's report does not say whether it is complete now, so the audit has to.
- Two sub-checks are not asserted. One is that a nested `invokeTool` starts no competing flow. The other is an execute alias after terminate.

After the fix round of 2026-11-26, at `2ca86ee`. The audit and the verifier of the round are running, and they decide which of the items above are closed.

- Recovery cannot tell whether a call without a result had started, because the runtime keeps no durable record of dispatch. Every such call gets one text that is true for both cases.
- For an optimization pass after spec conformance. The step runs 13 SQL statements where M1-5 runs 11. The two extra are a read of the queue and a lookup of tool results by `caller_seq`, both at every step, and both look avoidable when the queue is empty and the step's own calls were all stored. Measured overhead per step is between 15 and 19 percent above M1-5, depending on machine load.
- The descriptions of PR 2 to PR 8 on GitHub were written before the rebase and the fix rounds, and no longer match their commits.

From the audit of the fix round, at `2ca86ee`. The full lists are in `/tmp/swarm-m1-6/audit-c/report.md`.

- Fifteen behaviours of the fix round have no test. The audit found them by breaking each fix and running the suite. Among them are the commit-time check of an expired handle, the three ways an abort's hold is released, and three of the filters on pending queue entries.
- Nothing reads or removes a queue entry marked `failed_delivery`, and nothing removes the holder row of a killed process.
- Deleting a tool result reopens its call, and settlement then stores an error result for it.
- The refusal of a secret in queued arguments has no minimum length, does not name the variable, and misses a secret passed as a number.
- `appendMessages` and an `insertMessage` without a flow are unfenced. Only scripts and tests call them.
- A nested hook's handle does not inherit its parent's expiry.
- A database from an earlier build of PR 8 fails with "Failed to prepare statement" and no hint.
- For the structure review, ten points. The decision that a run lost its thread is made in four places. `Run` is six mutable signals shared by two files. The exit handler of `start` does four jobs. The ownership check is spelled three ways in the store. The stop check and the queued-call redaction each exist twice. Pairing rides on a `WeakMap` exported from the store's interface file. `recover` serves three callers through one optional id and one flag.

## M1-7, chat, and a cleanup PR after it

- `spindle send` prints only the status when another process ran the message. Its record stream must show the replies.
- A definition file that throws from a timer, or that leaves a rejected promise unhandled, crashes the process after the report prints.
- A definition file that calls `process.exit(0)` ends the run with exit code 0 and no report.
- A definition file with a top-level `await` that never settles hangs `spindle validate`. A load timeout needs a number from the operator.
- An agent whose `stopTool` names a package that does not exist is accepted, and the stop never happens. Validation must reject it.
- An error message shaped like `word: text` is read as a field path.
- A broken symlink under `agents/` gives a message that names a file inside Spindle's own build.
- `--dump-requests` output is not valid JSON when a secret contains a quote.
- `--dump-requests` shows redacted text, so it does not show what the provider received. The help text must say so.
- The scripted provider ignores `reasoning.exclude`.
- When a variable has both a default in a definition and a value in the instance environment, the default wins and nothing is printed. The command must say that the environment value was ignored and why.
- Shape checks that `spindle validate` does not make yet. `includeChat` as a boolean. The model capability fields. `maxSessionTurns: null`. A string `stopOnResponse`. The option types of a subagent relationship. `__meta.version` as semver. Stray parent-hook disclosures. `entryAgents` in `package.json` against `__meta.entryAgents`. The shapes of tool `args`, effect args, and a prompt's `requiredSchema`.

## A provider PR, or milestone 7

- The OpenAI-compatible provider drops `extra_content` on a tool call.
- The OpenAI-compatible provider does not forward `user`, sends no reasoning token budget, drops the `stream_options` sibling, reports zero usage when the endpoint sends none, accepts an empty JSON object from `generate`, and mishandles multi-line event data, an HTTP-date `Retry-After`, and status 408.

## Milestone 2

- Untrusted text that is interpolated into a prompt is not sanitized. Thread arguments arrive in M2.
- `envType` returns `secret` for every source. `setEnv` with a type arrives in M2.
- A handoff target is not checked for a human side.
- `forceTurn` is labelled as arriving in M2.

## Milestone 3

- An attachment's path is stored as given and is not redacted, because the runtime reads it back.
- A new file attachment in a tool result is refused with a message that names M3.
- Three curated quotes for Runtime lines 124, 177, and 200 leave out their condition.

## Process changes the operator approved on 2026-11-26

- A design note for each cross-cutting concern, written once and before milestone 2. The three are user code at the edge, secrets, and message invariants. A rule of that kind is no longer settled inside a fix-round brief.
- Every spec brief gets a failure-mode section, which lists what the model, the network, and user code can do wrong at each step and what the runtime must do then. M1-6 gets one as a supplement, because its owner was already building.
- GPT-6.2 Astra writes the conformance scenarios before a build, and a Claude owner implements until they pass. This starts with M1-7.
- Every audit is gated from its first round. Stored data lost or changed, a leaked secret, a tool call without its result, a tool that runs twice, two executions of one thread, or a thread that cannot continue blocks a PR. Everything else goes on this list.
- Claude models implement. GPT and Gemini models read and judge.
- Performance is reported and not gated until the runtime conforms to the spec. The plan's rule that a PR fails when its per-step median is more than 20 percent above its parent's no longer blocks a PR. One guard stays, against the architectural kind of problem. The cost of a step and the number of SQL statements per step must not grow with the length of the thread. A verifier checks that at two thread lengths and reports it.

## Before the stack lands

- Codex and Copilot left threads on every PR. An earlier version of this line said the commits address them. That was not checked, and Copilot has since raised four of PR 4's points again on its current head. One agent is checking every thread against the code. Valid ones are fixed in the PR they belong to as the stack is rebased. The operator said on 2026-11-26 to reply to the threads and resolve them, so that an open thread always means a point that is still valid. Each thread gets a reply that names the commit that fixes it or the recorded decision that declines it, and is then resolved. A reply goes out after its PR's rebased push, so that it cites a commit hash that still exists.
- The stack has six merge commits and is rebased to linear history, one PR at a time from the bottom, before the operator's review. The old tips get archive tags first, because the plan and this trail cite their commit hashes.
- For the structure review. The guard in `history.ts` against a history read inside a rolled-back transaction does nothing alone, because the store's guard already covers it. It can go.
- The operator's review of code quality and file structure, after which the full verification swarm runs on M1-2 to M1-7.

## Structure PRs, on top of the stack

Seven code quality reviews found that no PR of the stack meets the operator's bar for structure. The reports are under `docs/plans/trail/reviews/`. The operator chose new PRs on top of the stack, one at a time, each keeping behavior the same.

1. The Effect language service (`@effect/tsgo`), the hole in the platform lint rule, the two-way platform contract, and the entry point of the command line. Running.
2. A test harness module, and the split of the five scenario files and the one store test that are over 1,000 lines.
3. The store as three services (threads, messages, runs), one ownership check, `recover` split by caller, and positions returned from the insert in place of the `WeakMap`.
4. One state machine for the life of an execution, in place of the `Run` bag, the two finalizers, and the five releases of an abort's hold. Interrupts as a scoped service.
5. Hooks as three typed kinds owned by the operations they decorate, `createMessage` split in two, and the step loop cut down.
6. One shared module for the commands, one channel for a waiting line, and the chat as one fiber that drains one queue of events.
7. The registry validator lifted out of its generator, `Schema` at the boundaries where it removes code, and Effect's `Schedule`, `Stream`, and event-stream parser in the model call.

8. Fallow, added last, by the operator's decision of 2026-11-26. It gets a pinned development dependency, the configuration in `docs/plans/trail/reviews/fallow.md`, and one CI job outside the runtime matrix that runs its audit of a PR. The findings it has then are cleared in that PR, so that it starts from a clean baseline. Until then its findings go to the structure PR that owns the code: the two circular imports between `Registry.ts` and its two loaders go to PR 7, and the list of exports that nothing uses goes to each PR for its own files.

Found by the structure reviews and left. A `filter_messages` hook that returns a crafted `tool_calls` name on a visible call ends the run with `fatal_error`, where a value from a hook should never crash the loop. `extraContent` in a dispatched request is the history cache's own object, so a provider that mutates its request edits the cached history. The drain delivers every queued entry in one pass and stores a queued tool as the prompt side's call, which a handler side in milestone 2 cannot use.

Found by the review of structure PR 6 and left for the operator's code review, because none changes what a user sees. `settlement.isDone` in `Execution.ts` is read only by one test. `withProject` in `cli/shared.ts` takes seven positional parameters and carries a rule only the chat uses. The chat repeats the thread check that `open` already makes. `chat.ts` still squashes a cause and tests `instanceof` although the send's error channel is typed. A `waiting` event is dropped while the chat is stopping, which matters only for a Ctrl-C inside a window of microseconds. `runMain` hands an interrupt to every open subscription, and no command opens two. A command that fails on a store error prints `Failed to prepare statement` without SQLite's reason. On Node, two interrupts under 3 ms apart at the prompt end the chat by the signal more often than before (60 of 160 against 32), always after the resume line.

Older than the structure PRs, confirmed by that review. A line typed within half a millisecond of a Ctrl-C is echoed and not stored, with no note. A keyboard cannot produce that gap.

To check inside the PR that owns the code. A settlement that may run twice on a database error. `before_create_message` running twice when a tool result cannot be stored. Request assembly that parses every stored message at every step.

After them. The tool timeout setting, the updated PR descriptions, and the milestone revision.

## Decided by the operator on 2026-11-26

- A live process is never taken over. `spindle recover <thread> --force` settles a thread whose holder is frozen. To be looked at again in M4, when there is a long-lived server.
- A handle given to a tool or a hook stops working when it returns.
- A terminated thread accepts only an explicit injected message from outside.
- A tool call whose arguments hold a known secret is refused at `queueTool`.
- `spindle chat` with no `--db` keeps the thread in memory, says so, and prints no resume line.
- `spindle chat` prints what a successful tool returned, shortened on one line, with a flag for the whole of it. The build prints `ok`, so this is a change for the round after the M1-7 audit.
- A tool has no default deadline. A `--tool-timeout` flag and a per-tool setting are added, in a cleanup PR after M1-7. A tool past its limit gets an error result that says it timed out, its handle stops working, and the run goes on.
- The milestone list for M2 to M7 is revised after the operator's review of the code, not before.
- Performance is reported and not gated until the runtime conforms to the spec.

## Questions that wait for the milestone revision

- How a value is classified as secret once thread values carry a type, and whether a definition default follows the spec's default of secret. M2.
- Whether every request to a model gets one final check after all hooks, in every role. M2.
- Whether a create hook may change `parent_id` and `depth` when a nested prompt starts, and what deleting a parent call does to its nested conversation. M2.
- Whether a prefilter hook may send a request with an incomplete group of tool calls and results. M2.
- Where trusted access inside the process ends, and what a client may receive through an endpoint or a stream. M4 and M6.
- A total budget of time or writes for one operation and everything its hooks start. M2.

## Readings the operator can overrule

- A failing create hook cannot stop a write the loop must make, which is the human's message, the model's response, or a tool result. The loop stores the last good version. A hook that fails on an optional injected message does prevent it.
- `tool_call_done` fires, with an error result, for a call that began to stream in a response that then failed.
- An inbound human message meets the agent's hooks and not the prompt's.
- Only the store's own API may write to a thread. Raw SQL from outside it is not supported.
- No tool is replayed after a crash. An unanswered tool call gets an error result.
- A prompt variable whose value comes from the instance environment is refused, because the spec classifies that source as secret and forbids a secret in a system prompt. A default in an agent or prompt definition is treated as text.
- Prompt variables use the package's `env` prompt part. There is no placeholder syntax.
- The key-value store accepts plain JSON data only.
- A tool call whose arguments are not valid JSON is stored as `{"invalid_json": "<raw text>"}` and never runs.
- A secret has no minimum length for redaction.
- An execution that reaches the step cap ends, and work left in the queue waits for the next trigger.
