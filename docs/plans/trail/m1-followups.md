# Milestone 1 follow-ups

This file lists what the audits and verifiers of milestone 1 found and what the root deferred. Each item names the PR that takes it. The root removes an item when a test proves it fixed.

## M1-5, hooks

- Fixed in the M1-5 fix round. A secret is now replaced everywhere in text that a tool or a hook wrote, property names included.
- A request hook can put a secret into a message of a role other than system, and the provider receives it. The developer's hook wrote that text. This is a documented limit, not a defect.
- On a long thread, request assembly walks every stored message at every step, and each `filter_messages` hook gets a deep copy of the whole snapshot, which takes 8 ms at 5,000 messages.

## M1-6, queues and one execution per thread

- A tool that never returns has no deadline, and nothing can stop it.
- A model stream that stalls waits forever when the model sets no timeout.
- The stored run state stays `idle` after a run fails or the process is killed. The command line reports the failure, and the database does not.
- A storage failure after a tool has run leaves an assistant tool call with no result. Recovery must give that call an error result.
- The operator's open decision on a tool call that was running when the process died. The default is no replay. The next run stores an error result for that call.
- Cleanup on interrupt is incomplete.
- A caller of the runtime's API can pass `NaN` or `Infinity` as `retries`.
- A thread state that a tool kept and used after its run ended fails with a database driver error. It needs a typed error, as a hook past its time limit already has.
- Hooks that a tool's `injectMessage` started run on their own promise and survive an interrupt.

## M1-7, chat, and a cleanup PR after it

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

## Before the stack lands

- The review bot left threads on PR 4, PR 5, and PR 6. The commits address them, and nobody has replied to them or resolved them.
- The operator's review of code quality and file structure, after which the full verification swarm runs on M1-2 to M1-7.

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
