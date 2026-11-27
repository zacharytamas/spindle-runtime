# Close milestone 1 (M1c)

Written on 2026-11-27, after the milestone 1 stack landed on `main` at `251a044`. The scope comes from `docs/plans/milestones.md`, and the items come from `docs/plans/trail/m1-followups.md` on the `trail/m1` branch.

Milestone 1 closes when none of its ledger statements is `planned`, and every `partial` one either names the later milestone that owes the rest or is recorded as a divergence. M1c adds no spec page.

## How to read this

- A box is checked only when the thing it names is true on `main`.
- The seven rules of `docs/plans/milestones.md` apply. The ones that shape this plan are short stacks, tests before the build, and review depth by risk.
- The four pull requests are independent of each other. None is stacked on another.

## Program checklist

### Order and limits

- [ ] At most three pull requests are open at a time. The trail pull request, #9, is not counted, because it holds no code and nothing is stacked on it.
- [ ] M1c-1, M1c-2 and M1c-3 start together from `main`. M1c-4 starts when one of them has landed.
- [ ] A pull request that lands second or third is rebased onto `main` by its owner or by the root. `ledger.json` is the one file all four touch.

### Roles

- [ ] GPT-6.2 Astra builds. Claude Opus 5.5 writes the tests that come before a build, and reads what the risk of a change calls for.
- [ ] For M1c-2 and M1c-3, an Opus writer commits failing tests first, from the follow-up list and the spec text. The Astra builder implements until they pass, and records the reason in the pull request for any test it changes.
- [ ] M1c-1 is tests only, so no test comes before it. Its builder proves each new test by breaking the code it guards and showing the test fail.
- [ ] M1c-4 changes how a thread is held and released. It gets a section in `docs/design/thread-ownership.md` and its tests first, and a thirty-minute Opus reading review after the build.
- [ ] Every brief carries the clean-room rule, the Effect v4 rule, the rule against Grok models, the light-check rule, and the rule that no process is left behind.

### Checks, for every pull request

- [ ] One test file while iterating. The full `pnpm check` and `bun --bun run check` once at the end.
- [ ] `pnpm fallow` reports no issue.
- [ ] The ledger line changes only by the statements the pull request names.
- [ ] Bot threads are read against the head, answered, and resolved before the root reports the pull request ready.

## Prove what milestone 1 already does, and correct the ledger (M1c-1)

Tests and ledger only. A test that exposes a defect stops the builder, who reports it. The root decides whether the fix belongs here.

- [ ] One sweep of every `ThreadState` method closes the seven planned statements on the Threads page: `7c070519`, `19fce160`, `2e916e49`, `b97f0023`, `86d51bef`, `a22d57c1`, `28e54701`.
  - [ ] The members of a `ThreadState` are compared with the interface the spec package declares.
  - [ ] Each method rejects invalid parameters, passes a storage error to its caller as a rejection, and returns the empty value the spec names when nothing is found.
- [ ] The fifteen behaviors of the M1-6 fix round that had no test each have one, or are shown to have gained one since. The list is in `docs/plans/trail/m1-6-audit-c.md` on `trail/m1`. The code has been restructured since that audit, so each is checked again by breaking the fix.
- [ ] Ten partial statements become `covered`, each with a test: `distribution:packaging:3b8a316c`, `infrastructure:runtime:3b19a524`, `infrastructure:runtime:6e443a4c`, `infrastructure:runtime:dc7d7df0`, `specification:threads/messages:778b4467`, `specification:threads/execution-state:04d1538b`, `specification:threads/execution-state:da3295e2`, `specification:threads:39260b1a`, `specification:threads:a1ac0a36`, `specification:threads:9090af10`. One that needs runtime code, not only a test, is reported to the root and left `partial` with a reason that says what is missing.
- [ ] Five partial statements that Spindle cannot close are recorded in `DIVERGENCES.md` or as `not-testable`, with the reason: `specification:effects:b7593fb4`, `specification:hooks:f3dc7790`, `specification:hooks:ebcb97e7`, `specification:hooks:5cf7c4b6`, `specification:agents:13907439`.
- [ ] The eight partial statements that wait on a later feature name their milestone in the reason.
- [ ] The five planned statements that belong to M2, M4 and M7 move there.
- [ ] Every milestone label and every reason in the ledger uses the numbering of `docs/plans/milestones.md`, where M5 is the client API and M6 is code execution. The ledger check accepts `M1c`, `M2a`, `M2b`, `M3a` and `M3b`, or the plan records why it keeps whole numbers.
- [ ] Two tests the last review rounds left out: a write that commits after settlement from a hook that expired, and the wording of the hold note for a hook given up at its limit.

## Make `spindle validate` refuse what it accepts today (M1c-2)

- [ ] The shape checks it does not make yet, each with a fixture that fails for that reason alone.
  - [ ] `includeChat` as a boolean, the model capability fields, `maxSessionTurns: null`, and a string `stopOnResponse`.
  - [ ] The option types of a subagent relationship, `__meta.version` as semver, and stray parent-hook disclosures.
  - [ ] `entryAgents` in `package.json` against `__meta.entryAgents`.
  - [ ] The shapes of tool `args`, effect args, and a prompt's `requiredSchema`.
- [ ] An agent whose `stopTool` names a package that does not exist is rejected.
- [ ] A definition file cannot end, crash, or hang the command.
  - [ ] A file that throws from a timer or leaves a rejected promise unhandled gives a report and a failing exit code.
  - [ ] A file that calls `process.exit` does not end the run with code 0 and no report.
  - [ ] A file whose top-level `await` never settles is given up after a load time limit. The default is 30 seconds, the same as a hook's, and `--load-timeout` changes it. The operator can overrule the number.
- [ ] An error message shaped like `word: text` is not read as a field path.
- [ ] A broken symlink under `agents/` gives a message that names the link, not a file inside Spindle's build.
- [ ] `user-code-at-the-edge.md` says what a definition file may do while it loads, if the build changes that.

## Harden the OpenAI-compatible provider (M1c-3)

Each item is a test against a local server that sends the bytes named, with no real endpoint.

- [ ] Event data that spans several `data:` lines is joined as the event-stream standard says. One JSON object per `data:` line with no blank line between them still works, because real endpoints send that.
- [ ] A `Retry-After` header that holds an HTTP date is honored, and one that holds neither a number nor a date is ignored.
- [ ] Status 408 is retryable.
- [ ] Usage stays as three zero counts when the endpoint sends none, and no optional count appears. The spec package makes the three counts required, so they cannot be absent. A test pins this.
- [ ] `extra_content` on a tool call survives a round trip to the next request.
- [ ] `generate` rejects an empty JSON object as a response.
- [ ] `user` and the `stream_options` sibling are forwarded, or `DIVERGENCES.md` says why not.
- [ ] A reasoning token budget stays unsent, and the ledger reason for `specification:prompts:132940db` still says so.
- [ ] The check against sloppy input from the milestone revision holds: nothing here makes the provider stricter than real endpoints need.

## Clean the queue and the holder table, and close two limits of the hold (M1c-4)

- [ ] `docs/design/thread-ownership.md` gains a section that settles the four rules below before any code.
  - [ ] What reads a queue entry marked `failed_delivery`, what the operator is told, and what removes it.
  - [ ] When the holder row of a killed process is removed, and by whom.
  - [ ] A nested tool counts as pending from the call to `invokeTool`, not from the entry into its tool code.
  - [ ] An abort that arrives while a run waits for its callbacks keeps a failed last step's error, and what happens to queued work then.
- [ ] Tests for the four rules exist and fail before the build.
- [ ] The build passes them, and scenarios O11 and O12 still pass unchanged.
- [ ] An Opus reading review of thirty minutes finds no stored data lost or changed, no tool that runs twice, no two executions of one thread, and no thread that cannot continue.

## Close the program

- [ ] The ledger line shows no planned statement in milestone 1.
- [ ] `docs/plans/milestones.md` records what M1c cost, in pull requests and in days, against this plan's four.
- [ ] The follow-up list on `trail/m1` loses every item M1c closed, and keeps the rest under the milestone that owes it.
- [ ] The design note on sides and turns, which M2a needs, is written while M1c is built. It is its own pull request and is not part of M1c.

## Not in M1c

- The Ctrl-C limit of `spindle chat` under a blocked pipe, and the long line at a terminal. `chat` is a debug tool.
- An abort that does not wait for a custom provider that ignores the signal. It is failure mode 15 of the ownership note.
- The other items of the M1-7 follow-up list that concern `--dump-requests`, `spindle send`, and the scripted provider. They change what a debug command prints, and none is owed to a ledger statement.
