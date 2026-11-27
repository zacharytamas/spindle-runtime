# Milestones after milestone 1

Revised on 2026-11-27, after milestone 1 was built and reviewed. This replaces the table that was Appendix E of `m1-core-loop.md`.

The operator accepted the list and the rules on 2026-11-27. The answers to the six design questions are still recommendations, and the section "Decisions the operator owes" lists what is open.

## What milestone 1 cost

The plan named seven pull requests. Building it took twenty-three.

| Kind | Count | Pull requests |
|---|---|---|
| Planned features | 7 | M1-1 to M1-7 |
| Structure, after the code quality review | 9 | M1-8 to M1-16 |
| A feature the operator added | 1 | M1-17, the tool time limit |
| Fixes from review threads and audits | 3 | M1-18, M1-19, M1-20 |
| Plan and trail | 2 | #1, #9 |

- The runtime is 8,803 lines of source. Tests and conformance scenarios are 20,579 lines, and 594 tests pass on Node and on Bun.
- The ledger assigns 440 requirement statements to milestone 1. 357 are covered, 58 are partial, 12 are still planned, and 13 are not testable.
- `DIVERGENCES.md` has 21 entries.
- Fewer than a third of the pull requests were planned ones. The rest came from three causes, and each has a rule below.

**Cause 1: the features were not built to a structure bar.** Seven reviews found that no feature pull request met it, and nine pull requests rewrote about 3,240 lines for a net of 56 fewer. That work bought a state machine for an execution, hooks owned by their operations, and a chat with one consumer of events. It would have cost far less inside the feature pull requests.

**Cause 2: cross-cutting rules were settled inside fix rounds.** The redaction rule changed three times and the ownership rule twice before a design note fixed each.

**Cause 3: a tall stack multiplies review.** Each merge at the bottom rebased everything above it, and the review bots read every pull request again. Two merges on 2026-11-27 produced thirteen new threads. Seven of them were true, and none of those would be met in ordinary use.

## Rules for the next milestones

1. **The structure bar is part of the build brief.** A brief names the modules a feature may touch, the state it may share, and the size a function may reach. Fallow and the Effect checker now enforce part of this in CI.
2. **A design note comes before the milestone that needs it.** Sides and turns before M2. Typed thread values and secrets before M2. The trust boundary of a server before M4.
3. **Stacks stay short.** At most three open pull requests. A pull request lands when it is green and read, and the next one starts from `main`.
4. **Review depth follows risk.** A behavior audit for a feature. A thirty-minute reading review for code that reads a network or manages a lifetime. The builder's comparison of base against head for a pure refactor. A fix round takes only what changes behavior.
5. **Scenarios are written before the build**, from the spec text, by a different model than the one that builds.
6. **Performance is reported and not gated.** One guard stays: the cost of a step must not grow with the length of the thread.
7. **Local checks stay light.** One test file while iterating and the full check once at the end. The full check takes about 31 seconds.

## The revised list

The statement counts come from the ledger. Each is a floor. Only the Runtime, Hooks, Messages and Agents pages have been read for requirements that carry no keyword, so the counts for the other pages will grow when their milestone reads them.

| Order | Milestone | Scope | Statements | Main risk |
|---|---|---|---|---|
| 1 | M1c, close milestone 1 | What milestone 1 still owes. No new spec page. | 25 of M1's | Scope creep from the follow-up list |
| 2 | M2a, sides and turns | Handler sides, two prompt sides, session turns, `forceTurn` | about 30 | The step loop and the drain assume one prompt side |
| 3 | M2b, tools between sides and thread values | Prompt tools, handoff tools, session tools, thread environment values with types | about 30 | How a typed value is classified as secret |
| 4 | M3a, the thread filesystem | Files, attachments that are new files, attachment copying | about 50 | A second kind of durable state beside SQLite |
| 5 | M3b, subagents | Child threads, parent hooks, the subagent registry | about 50 | One execution per thread becomes a tree of them |
| 6 | M4, a server | A long-lived process on `NodeHttpServer` and `BunHttpServer`, scheduled effects, `decide()`, thread endpoints | 33 | The ownership rule was written for short-lived commands |
| 7 | M5, the client API | The Thread Client API over HTTP and WebSocket | 149 | The largest page, and the first untrusted callers |
| 8 | M6, code execution | `runCode` in a sandbox, after a prototype picks the engine | 52 | No engine is chosen. This is the largest unknown |
| 9 | M7, models and the rest | Model fallbacks and pricing, provider tools, type registry generation, agent skills, runtime streams | 52 | Low |
| | Later | Users, when the page leaves Draft | 58 | The page is a Draft |

Version 1 is M1 through M4, as before.

### What changed from the old list

- **M1c is new.** Milestone 1 cannot close by its own rule, because 12 of its statements are still planned.
- **M2 and M3 are each split in two.** Each half has one structural change to the runtime, and the rule on short stacks needs a place to land between them.
- **The client API moves ahead of code execution.** It depends only on the server, and it is what lets an application use Spindle. Code execution depends on a choice nobody has made.
- **Provider hardening moves from M7 into M1c.** Anyone who points Spindle at a real endpoint meets those gaps now.

## Each milestone

### M1c, close milestone 1

- **Ledger.** Seven planned statements that milestone 1 owes, all on the Threads page, which need one sweep of every `ThreadState` method. Eighteen partial statements whose reason names no later milestone. The other five planned statements belong to M2, M5 and M7 and move there.
- **`spindle validate`.** The shape checks it does not make yet. A definition file that throws from a timer, calls `process.exit`, or never finishes loading. An agent whose `stopTool` names a package that does not exist.
- **The OpenAI-compatible provider.** Multi-line event data, an HTTP-date `Retry-After`, status 408, zero usage when the endpoint sends none, the dropped `extra_content`, and the fields it does not forward.
- **The queue and the holder table.** Nothing reads or removes an entry marked `failed_delivery`, and nothing removes the holder row of a killed process.
- **Tests owed.** Fifteen behaviors of the M1-6 fix round have no test.
- **Limits from the last review rounds**, where the fix is small: count a nested tool from the moment `invokeTool` is called, and keep a failed step's error when an abort arrives during the wait.

Not in M1c: the Ctrl-C limit of `spindle chat` under a blocked pipe, and the long line at a terminal. `chat` is a debug tool.

### M2a, sides and turns

- **Scope.** A handler side. Two prompt sides. Session turns and `maxSessionTurns`. `forceTurn`.
- **What it changes.** The step loop runs a prompt side against a human side. A side becomes a value the loop is given. The drain stores a queued tool as the prompt side's call, which a handler side cannot use.
- **Before it starts.** A design note on sides and turns.

### M2b, tools between sides and thread values

- **Scope.** Prompt tools, handoff tools and session tools. Thread environment values with a type, and `setEnv`. Thread arguments in prompt interpolation, validated first.
- **What it changes.** Request assembly gains inputs that a user wrote. `envType` returns `secret` for every source today.
- **Before it starts.** The design note on secrets is revised for typed values, and design questions 1 to 4 and 6 below are decided.

### M3a, the thread filesystem

- **Scope.** The Filesystem page, Runtime sections 7 and 8 for files, and a tool result that carries a new file.
- **What it changes.** An attachment's path is stored as given today, and a new file is refused with a message that names this milestone.
- **Open.** Where the files live, and whether a file write joins the SQLite transaction that stores its message.

### M3b, subagents

- **Scope.** The Subagents page, parent hooks, and `setStatus` into the parent's registry.
- **What it changes.** Recovery, abort and the hold all reason about one flow per thread. A parent that waits on a child needs each of them to reason about a tree.
- **Before it starts.** `docs/design/thread-ownership.md` gains a section on parent and child flows.

### M4, a server

- **Scope.** The Effects, Decisions and Endpoints pages, and an HTTP server.
- **What it changes.** A live process is never taken over today, and `spindle recover --force` is the way out. That was decided for commands that exit. A server that runs for weeks needs the decision looked at again, as the operator noted on 2026-11-26.
- **Before it starts.** A design note on the trust boundary, which answers design question 5.

### M5, the client API

- **Scope.** The Client API page, 126 statements, and the 23 statements on other pages that wait for it.
- **Open.** The old list said "tested with the official client". The license of that client has to be checked against the clean-room rule before any brief names it.

### M6, code execution

- **Scope.** The Code Execution page and Runtime section 14.
- **First step.** A prototype that compares engines on isolation, start time, and what Node and Bun both support. No build before it reports.

### M7, models and the rest

- **Scope.** Model fallbacks and pricing, provider tools and `getTools`, the type registry, agent skills, and runtime streams. 22 of its 52 statements are MAY.

## Design questions that waited for this revision

Each has a recommendation. None is decided.

1. **How is a value classified as secret once thread values carry a type?** Recommendation: follow the spec's default, so a value is secret unless its definition says otherwise. The cost is that a short common word declared with no type is redacted everywhere, so the minimum length for redaction has to be decided with it.
2. **Does every request to a model get one final check after all hooks, in every role?** Recommendation: yes, one pass at the end of assembly. It reverses a limit that milestone 1 documents, that a request hook can put a secret into a message of a role other than system.
3. **May a create hook change `parent_id` and `depth` when a nested prompt starts?** Recommendation: no. They are facts the runtime wrote, like `flow_id` and `caller_seq`, and recovery must not depend on a field a hook can change. Deleting a parent call follows the existing cascade.
4. **May a prefilter hook send a request with an incomplete group of tool calls and results?** Recommendation: no. The final check of question 2 refuses it, because providers reject it anyway and the error is then far from its cause.
5. **Where does trusted access end?** Recommendation: tools and hooks in the process are trusted. Anything that crosses an endpoint or a stream is an untrusted client and receives only stored, redacted data. The M4 design note settles the details.
6. **Is there a total budget of time or writes for one operation and everything its hooks start?** Recommendation: a time budget only. A nested hook or tool inherits its parent's deadline, which it does not today. No budget on writes.

## Decided by the operator on 2026-11-27

- M1c exists. Provider hardening moves into it from M7.
- M2 and M3 are each split in two.
- The client API comes before code execution.
- At most three pull requests are open at a time.

## Decisions the operator owes

- The six design questions above. Questions 1 to 4 and 6 block M2b, and question 5 blocks M4.
- Whether the official client may be used to test M5, once its license is checked against the clean-room rule.
