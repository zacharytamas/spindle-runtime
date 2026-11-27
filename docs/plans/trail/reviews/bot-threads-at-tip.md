# Thirteen open review threads, checked at the top of the stack

All checks ran at `e410aae` (`origin/m1/17-tool-timeout`, PR 20), after `pnpm install --frozen-lockfile` and `pnpm build`. The machine is macOS 27.2.1 (Darwin 27.2.0, arm64). The runtimes are Node 22.22.3 and Bun 1.4.5. I did not run the whole suite. Every script is in `/tmp/structure/threads/scratch/`. Each ran through `scratch/tl.py`, which starts the command in its own process group and kills the group at its time limit. The repository is unchanged (`git status` is empty), and I posted nothing.

PR numbers map to branches as follows: PR 5 is `m1/2-registry`, PR 6 is `m1/4-step-loop`, PR 7 is `m1/5-hooks`, PR 8 is `m1/6-queue`, PR 10 is `m1/7-chat`, PR 11 is `m1/8-effect-rules`, PR 12 is `m1/9-test-harness`, and PR 20 is `m1/17-tool-timeout`.

| Thread | PR | Subject | Class | Ran or reasoned |
|---|---|---|---|---|
| PRRT_kwDOV8Uz-c68bL99 | 5 | Definition logs break validate JSON | Should fix | Ran, Node and Bun |
| PRRT_kwDOV8Uz-c68bL-q | 5 | Sparse entryAgents hides entry agent | Record | Ran, Node and Bun |
| PRRT_kwDOV8Uz-c68bKYx | 6 | Cyclic metadata keeps secret unredacted | Record | Ran, Node |
| PRRT_kwDOV8Uz-c68bKZh | 6 | Deleted trigger resets turn boundary | Fixed since (99c4c0a, PR 7) | Ran, Node and Bun |
| PRRT_kwDOV8Uz-c68bKaJ | 6 | Own-side attachments missing from request | Record | Ran, Node and Bun |
| PRRT_kwDOV8Uz-c68k-QR | 6 | Instance env read errors become absence | Record (already recorded) | Ran, Node and Bun |
| PRRT_kwDOV8Uz-c68bKd8 | 7 | structuredClone hides class error_data | Record | Ran, Node and Bun |
| PRRT_kwDOV8Uz-c68gLsx | 8 | Unawaited invokeTool outlives the claim | Record, needs a decision | Ran, Node and Bun |
| PRRT_kwDOV8Uz-c68gLtH | 8 | Renamed caller loses its result | Blocks | Ran, Node and Bun |
| PRRT_kwDOV8Uz-c68hRuo | 10 | Canonical mode limits terminal lines | Blocks | Ran on a macOS pseudo-terminal, Node and Bun. Linux not measured |
| PRRT_kwDOV8Uz-c68k8-1 | 10 | Signal during creation hook loses resume | Blocks | Ran, Node and Bun |
| PRRT_kwDOV8Uz-c68nmVM | 11 | isMain fails under preserve-symlinks | Record | Ran, simulated on Node 22.22.3 and Bun |
| PRRT_kwDOV8Uz-c68nmJH | 12 | Admission poll resolves on timeout | Record | Helper ran on Node and Bun. Q34 reasoned |

---

## PR 5, PRRT_kwDOV8Uz-c68bL99: `cli/validate.ts`, output from a loading definition

**Where.** `packages/runtime/src/cli/validate.ts:82` builds the registry, which imports every definition file in this process. Line 83 then prints the JSON. Nothing captures or redirects what user code writes to stdout while it loads.

**True?** Yes. Script: `scratch/t1.sh`, project `scratch/t1` (the hello-world fixture plus `agents/tools/noisy.ts`, which runs `console.log("loading")` at the top level). On Node and on Bun, `spindle validate --json .` exits 0 and prints `loading` and then `[]`. `JSON.parse` of that stdout fails with `Unexpected token 'l'`. `run` and `chat` do the same. `run assistant -m hi --script reply.json` prints `loading` and then `hello back` on stdout, and `chat` prints `loading` before the first `> ` prompt, on both runtimes. Their own `spindle:` lines go to stderr and are not affected.

**How much.** Should fix. A `console.log` left in a definition while debugging is common. It breaks every consumer that parses `validate --json`, such as CI. It matches none of the blocking cases.

**Smallest fix.** In `cli/validate.ts`, when `--json` is set, point `console.log`, `console.info` and `console.debug` at `console.error` while `validate` runs (lines 82–83), and restore them after. That is about 10 lines. A write straight to `process.stdout.write` would still get through, so a complete fix would also wrap that write. Pin it with a subprocess case in `test/cli/validate.test.ts`: a project with a logging definition, where `JSON.parse(stdout)` succeeds and `loading` appears on stderr. Whether `run` and `chat` should also move definition output to stderr is a separate decision. For them stdout carries the reply, and the recorded decisions do not say whether user output may share it.

**Reply.**
> This is still true. With a definition that calls `console.log` at load, `spindle validate --json` prints that line before the JSON array and the output does not parse, on Node and on Bun. The fix is in PR #__ of this stack.

---

## PR 5, PRRT_kwDOV8Uz-c68bL-q: `registry/load-packages.ts`, sparse `__meta.entryAgents`

**Where.** `packages/runtime/src/registry/load-packages.ts:9-10` (`isStringArray` uses `every`), `:17` (the meta check) and `:202-203` (the spread and the fallback to `[]`).

**True?** Yes. Script: `scratch/t2.sh`, which uses the `packed-a` fixture once as it is and once with `entryAgents: Object.assign(["researcher"], { length: 2 })`. With the dense list, `validate --list` shows `packed-a/researcher` as `entry`. With the sparse list it shows `internal` and reports 0 errors and no `package_meta_invalid`. The result is the same on Node and on Bun.

**How much.** Record. A packer writes a plain array, so ordinary use does not produce a sparse one. The effect is that one package's entry agents disappear quietly.

**Smallest fix.** Replace `every` in `isStringArray` with an index loop over `0..length-1` that rejects holes, or check `Object.keys(value).length === value.length`. That is about 3 lines. Pin it with a case in the registry tests: a packed package whose `__meta.entryAgents` has a hole reports `package_meta_invalid`.

**Reply.**
> This is still true. `isStringArray` in `registry/load-packages.ts:9` uses `every`, which skips holes, so a sparse `entryAgents` passes the check and the spread at line 202 turns the whole list into `[]`. We checked it with the `packed-a` fixture. The fix is in PR #__ of this stack.

---

## PR 6, PRRT_kwDOV8Uz-c68bKYx: cyclic provider metadata in the model-call log

**Where.** The code has moved. `packages/runtime/src/execution/step.ts:133-139` (`redactLog`) calls `mapStrings` from `execution/redact.ts:24-40`. That function returns a cyclic or non-plain branch as it is, so the back-reference points at the original, unredacted object. `step.ts:155` applies it to `call.metadata`, which `execution/call.ts:357` sets from `getResponseMetadata`.

**True?** Yes. Script: `scratch/t3-cyclic-metadata.ts`, run on Node. A `ScriptedProvider` returns `{ token: SECRET, self: <the same object> }` from `getResponseMetadata`, and the secret is in the supervisor's secret set. In the returned `outcome.modelCalls[0].metadata`, `token` is `[redacted]` and `self.token` is the raw secret.

**How much.** Record. The secret is not shown or stored anywhere at the top of the stack. No CLI command prints `RunOutcome.modelCalls`, no store table keeps it, and the package exports only `openaiCompatible` (`src/index.ts`). Only tests and the conformance driver read it. The bundled `openaiCompatible` has no `getResponseMetadata`, so only a custom provider that returns cyclic metadata hits this. It becomes Blocks as soon as a later milestone prints or exposes model-call logs.

**Smallest fix.** In `step.ts` `redactLog`, run the data through `JSON.parse(JSON.stringify(data))` inside the existing `try` before `mapStrings`. A cycle then throws, and the code already turns that into `null`. That is 1 line. Pin it with a scenario next to the `getResponseMetadata` cases in `conformance/src/scenarios/step-loop/provider-responses.ts`: cyclic metadata holding a known secret gives `metadata: null`, and `holding(outcome, secret)` is empty.

**Reply.**
> This is still true. The redaction moved to `redactLog` in `execution/step.ts:133`, and it still calls `mapStrings`, which leaves a cyclic branch unredacted. A provider that returns `{ token, self }` keeps the secret at `self.token`. The fix is in PR #__ of this stack.

---

## PR 6, PRRT_kwDOV8Uz-c68bKZh: a deleted trigger message resets the turn boundary

**Where.** The code has moved. `packages/runtime/src/execution/assemble.ts:171-179` (`pastOf`) now returns the set of ids of the past messages, read once when the turn starts (`execution/step.ts:306-310`). `toProviderMessages` checks `view.past.has(message.id)` (`assemble.ts:265`), so deleting a message later cannot move the boundary.

**True?** Fixed since. Commit `99c4c0a` ("run hooks at every position of the step loop", on `m1/5-hooks`, PR 7) made `past` a `ReadonlySet<string>`. Script: `scratch/t4-delete-trigger.ts`, with `includeChat: false` and `includePastTools: false`. The first send is `OLD-HUMAN-TEXT`. In the second turn a tool deletes the `NEW-HUMAN-TEXT` message that started it. The next request holds only the system prompt, the call and its result. Neither the old human text nor the old reply comes back. The result is the same on Node and on Bun.

**How much.** Fixed since.

**Smallest fix.** None.

**Reply.**
> This was fixed later in the stack. Commit 99c4c0a makes `pastOf` (`execution/assemble.ts:172`) return the ids of the past messages, read once when the turn starts, so deleting the triggering message no longer resets the cutoff. We checked it by having a tool delete that message with `includeChat` and `includePastTools` false. The next request held no earlier text or tool pairs.

---

## PR 6, PRRT_kwDOV8Uz-c68bKaJ: own-side messages skip `textOf`

**Where.** `packages/runtime/src/execution/assemble.ts:289-296`. An own-side message sends `message.content` and nothing else. `textOf` (lines 154-157) is applied only to the other side (line 283) and to tool results (line 272). Line 290 omits a past own message whose content is empty.

**True?** Yes. Script: `scratch/t5-own-attachments.ts`. A tool calls `queueMessage` with `{ role: "assistant", content: "WITH-TEXT", attachments: [ref] }`, then with an attachment-only assistant message, then with a user message that has an attachment. With `includeChat: true`, the next request shows the user message as `USER-WITH-FILE\n[Attachment user.png …]`. The assistant message appears as just `WITH-TEXT`, and the attachment-only one appears as `""`. In the following turn the attachment-only message is gone. The result is the same on Node and on Bun.

**How much.** Record. Ordinary use in M1 does not produce an own-side message with attachments. The CLI has no way to attach a file, model responses do not store attachments, and an attachment reference has nothing to point at until the thread file system arrives in M3. Only a tool or hook that queues an assistant-role message with a reference reaches it.

**Smallest fix.** At `assemble.ts:289`, use `textOf(message)` in place of `message.content`. Keep `null` when the message has no content and no attachments, so that an assistant turn that only calls tools stays `content: null`. That is about 3 lines. Pin it with a request-assembly test: an own message with a reference shows its description, and an attachment-only past own message is kept when `includeChat` is true.

**Reply.**
> This is still true. Own-side messages at `execution/assemble.ts:289` send `message.content` without `textOf`, so their attachment references are not described and an attachment-only own message is dropped from past history. Only a tool or hook that queues an assistant-role message with a reference can produce one in M1. The fix is in PR #__ of this stack.

---

## PR 6, PRRT_kwDOV8Uz-c68k-QR: instance environment read failures become absence

**Where.** `packages/runtime/src/execution/env.ts:44-47`. `instanceEnv` ends with `Effect.orElseSucceed(() => undefined)`. Its callers are `ThreadState.instanceEnv` (`execution/thread-state.ts:296`), `lookupEnv` (`env.ts:52`), provider config (`providers/config.ts:35,51`) and secret learning (`execution/step.ts:114`).

**True?** Yes. Script: `scratch/t6-instance-env.ts`, with a `ConfigProvider.make` that fails with `SourceError("vault unreachable")`. `Config.option(Config.String(…))` alone fails with `ConfigError(SourceError: vault unreachable)`, because Effect 4.1.5's `withDefault` only covers missing data. Spindle's `instanceEnv` succeeds with `undefined`. The result is the same on Node and on Bun. The spec, `specification/threads.md` §2.3 and `users.md`, says `instanceEnv` "rejects when the runtime cannot read its instance environment".

**How much.** Record. The CLI reads the process environment, and that read cannot fail this way. Only an embedder that supplies a `ConfigProvider` backed by something that can fail reaches it. The divergence is already written down in `docs/design/secrets.md:71`: "The M1 helper converts instance config read errors to absence, although the optional capability is specified to reject read failures." `packages/conformance/DIVERGENCES.md` does not list it.

**Smallest fix.** Remove the `orElseSucceed` from `instanceEnv`, so that it fails with `ConfigError`. Let `ThreadState.instanceEnv` reject, and let provider config resolution fail the run as a setup error. That is about 10 lines across `env.ts`, `thread-state.ts` and `providers/config.ts`. One decision is not settled: whether `env()`, through `lookupEnv`, and secret learning should also fail on a read error, or keep treating it as absence. The spec states the rejection only for `instanceEnv`. Pin it with a scenario using a failing `ConfigProvider`: `state.instanceEnv` rejects, and a provider slot with `defaultEnv` fails the run without falling back to its default.

**Reply.**
> This is true at the top of the stack and is a known divergence. `instanceEnv` in `execution/env.ts:44` still turns a `ConfigError` into `undefined`, and `docs/design/secrets.md:71` records that. The CLI reads the process environment, which cannot fail this way, so only an embedder's own `ConfigProvider` reaches it. The fix is in PR #__ of this stack.

---

## PR 7, PRRT_kwDOV8Uz-c68bKd8: `structuredClone` of `error_data`

**Where.** `packages/runtime/src/execution/tools.ts:255-258` (`storedResult`) puts `structuredClone(result.error_data)` in the metadata. The store's JSON check, `store/json.ts:66-76`, would reject a class instance or an object with `toJSON`, but by then it only sees the clone. The fallback is `execution/tool-lifecycle.ts:94-96`.

**True?** Yes. Script: `scratch/t7-error-data.ts`. A tool returns `error_data: new Details()`, where the class has fields `code` and `internal` and a `toJSON()` that returns `{ summary: "only this" }`. `toJson` on the original reports `a Details object`. The stored message has `tool_status: "error"`, content `"bad"`, and `metadata.error_data = {"code":42,"internal":"x"}`. The own fields are kept, `toJSON` is ignored, and no "Spindle dropped the error data" note appears. The result is the same on Node and on Bun.

**How much.** Record. `error_data` is typed as a plain record, and tools return object literals there. A class instance with its own `toJSON` is not ordinary input. The stored value is the instance's own fields, not what its `toJSON` describes.

**Smallest fix.** In `storedResult`, replace `structuredClone(result.error_data)` with `toJson(result.error_data)`. When that returns a `NotJson`, throw `ResultUnreadable` (or `ValueNotJson`) so the existing fallback at `tool-lifecycle.ts:95` runs. Otherwise store `JSON.parse(text)`. That is about 6 lines. Pin it with a tool-lifecycle test where class-instance `error_data` stores an error result with the "dropped the error data" note and no `error_data`.

**Reply.**
> This is still true. `storedResult` in `execution/tools.ts:258` clones `error_data` with `structuredClone`, so a class instance is stored as its own fields and the unstorable-result fallback never runs. We checked it with a class whose `toJSON` differs. The fix is in PR #__ of this stack.

---

## PR 8, PRRT_kwDOV8Uz-c68gLsx: an unawaited `invokeTool` outlives the claim

**Where.** `packages/runtime/src/execution/Execution.ts:132-178`. After a successful `advance`, `finish` settles at once. It waits on `#released`, which tracks `#pending`, only when the run was interrupted while holding (line 142). `ThreadState.invokeTool` is at `execution/thread-state.ts:327-335`. The nested call registers its promise through `Execution.call` (`execution/tools.ts:116-120`). With a tool time limit, the nested call's timer fiber is forked into the side's scope (`execution/callback.ts:43-44`, `tools.ts:122-125`).

**True?** Yes. Script: `scratch/t8-unawaited-invoke.ts`, run on Node and Bun, with no limit and with a 200 ms limit for every tool. Tool `starter` calls `state.invokeTool("slow")` without awaiting it and returns. `slow` waits for the test. The results:

- The first send settles `idle stop_on_response` about 25 ms after `slow` starts. The thread reads `idle`.
- A second send starts and settles a new flow while `slow` is still running.
- When `slow` is released, it runs its own code, which in real use is the external effect. Its `state.setValue` is refused with `ExecutionEnded`, and nothing is stored.
- With the tool time limit, the limit does not hold the claim either. The scope that held the nested timer closes at settlement, about 50 ms in, before the 200 ms deadline. The un-awaited `invokeTool` promise rejects with "All fibers interrupted without error", and the JavaScript of `slow` keeps running.

**How much.** Record, and it needs a decision. Thread data stays safe, because the old flow's writes are refused. Overlap of the old tool's outside effects with a new flow is what rule 5 of `docs/design/thread-ownership.md` prevents for an abort. The "Decisions for the M1-6 fix round" section states that rule only for abort, while the later section (line 116) asks for a hold until the last registered callback settles, including nested invokes. Calling `invokeTool` without awaiting it is a bug in the tool, not ordinary use. If the operator reads rule 5 as covering every settlement, this becomes Blocks under "two executions of one thread at once".

**Decision needed.** Should ordinary settlement hold the claim while a registered callback of the flow is still pending, as an abort does, or settle at once and rely on the refused writes? The spec and the recorded decisions do not settle this. If the answer is to hold, the smallest fix is in `Execution.ts` `finish`: before settling a successful exit with `#pending.size > 0`, enter the holding phase and await `#released`. Termination and forced recovery already end the wait through `FlowEnded`. That is about 6 lines. Pin it with a scenario like the script: the second send waits until `slow` returns.

**Reply.**
> This is still true. `Execution.ts:132` settles a successful run without waiting for registered callbacks, so a nested tool started by an unawaited `invokeTool` keeps running after the claim is released, and a new flow can start. Its writes are refused with `ExecutionEnded`, but its outside effects are not stopped, and the tool time limit does not hold the claim either. Whether ordinary settlement should wait as an abort does is an open decision, and the change, if made, is in PR #__ of this stack.

---

## PR 8, PRRT_kwDOV8Uz-c68gLtH: a `filter_messages` hook that renames a caller

**Where.** The code has moved. Position restoration is now in `packages/runtime/src/execution/assemble.ts:367-376`. A message whose id differs from the row at its index is looked up by id. A renamed caller is not found and loses `seq`. Its result keeps `callerSeq`, and visibility is decided by `shownBySeq.get(callerSeq)` (`assemble.ts:266-271`), so the result is hidden while the call is still sent (lines 285-296).

**True?** Yes. Script: `scratch/t9-rename-caller.ts`, with a `filter_messages` hook that returns every message holding `tool_calls` with `id` set to `<id>-renamed`. Without the rename, the second request holds the call `c1` and its result. With the rename, it holds the call `c1` and no tool message, and the script reports `calls without a result: ['c1']`. The result is the same on Node and on Bun.

**How much.** Blocks. The request sent to the model holds a tool call without its result. The stored pairing is intact, so the damage is in the request, not in storage. A chat-completions provider rejects such a request, which I reasoned from the format rather than ran, since no real model was used. So the step fails while that call is in view. The trigger is a hook that gives a caller a new id, which the spec allows but which is not common.

**Smallest fix.** In `toProviderMessages`, a tool result whose `callerSeq` belongs to no row in this request should fall back to the id-based pairing that results without `callerSeq` already use. Concretely, treat `callerSeq` as null when no row has that `seq`, and set `needsIds` accordingly. A reused call id stays isolated whenever its caller keeps its seq. That is about 6 lines in `assemble.ts`. Pin it with the script as a conformance scenario in the hooks group, where the renamed caller still gets its result in the request.

**Reply.**
> This is still true. The position restoration moved to `execution/assemble.ts:367`. A caller whose id a `filter_messages` hook changes loses its `seq`, and its result, matched through `callerSeq`, is dropped, so the request carries the call without a result. We reproduced it with a hook that renames the caller. The fix is in PR #__ of this stack.

---

## PR 10, PRRT_kwDOV8Uz-c68hRuo: `platform/chat-terminal.ts`, long lines at a terminal

**Where.** `packages/runtime/src/platform/chat-terminal.ts:29-31`. stdin is read with `setEncoding("utf8")` and `data` events, and the terminal is left in canonical mode. Nothing in `src/` calls `setRawMode` or uses `readline`. Plan Appendix A, `docs/plans/m1-core-loop.md:927`, records that `readLine` "never requests raw mode".

**True?** Yes on macOS, and the effect there is worse than the comment says. Measured with `scratch/t10/pty_type.py` and `pty_type2.py`, which use Python's `pty.fork` on macOS 27.2.1. On that pseudo-terminal `ICANON` is on and `MAX_CANON = MAX_INPUT = 1024`.

- **A reader with the same stdin pattern** (`scratch/t10/reader.mjs`): a line of 1,000 or 1,023 characters plus Enter arrives whole. At 1,024, 1,100, 4,094, 4,095, 4,096 and 10,000 characters no line arrives at all, because the driver drops the characters past its limit, including Enter. Ctrl-D twice does not end input either. Bun behaves the same at 1,100 and 1,023.
- **Recovery:** Ctrl-U then `hi` Enter delivers `hi`. 100 backspaces then Enter delivers a 924-character line, the first 1,024 kept by the driver minus 100, without the user's suffix.
- **Real `spindle chat --db … --script … --dump-requests`** (`scratch/t10`): at 1,000 and 1,023 characters the reply is shown and the request holds the full line. At 1,024 and 1,100 characters the terminal echoes only 1,024 characters, Enter does nothing, no request is sent and no message is printed. The chat waits until Ctrl-C, which then exits 0 with the thread id and the resume line. The result is the same on Node and on Bun.
- **Linux:** I could not measure Linux on this machine. The comment's 4,095 figure and its claim that Linux delivers a truncated line (rather than none) are not checked here.

**How much.** Blocks. On macOS, pasting a prompt of 1 KB or more into `spindle chat` is ordinary use, and it makes the command hang with no message. Backspacing or Ctrl-U then sends a line shorter than what the user pasted. On Linux, if the comment is right, the stored message is silently cut.

**Smallest fix.** This needs a decision first, because it changes how the chat reads keys. Leaving canonical mode means Spindle, not the driver, handles editing, Ctrl-C and Ctrl-D. The smallest version: when `input.isTTY`, read lines with `node:readline` `createInterface({ input, output, terminal: true })` in `chat-terminal.ts`. Map `line` to the queue and `close` to `finish`. Forward the interface's `SIGINT` event to the same path the `keyboard` emitter in `platform/interrupts.ts` serves, so the first and second Ctrl-C keep their meaning. Keep the pipe path as it is. That is about 30 lines. Bun's `node:readline` in terminal mode needs checking before relying on it. Pin it with a chat test through `test/cli/terminal.py` that types a 10,000-character line and asserts the dumped request holds all 10,000, plus the existing Ctrl-C and Ctrl-D cases.

**Decision needed.** Whether the chat takes over line editing in raw mode, through `node:readline` or its own code, or keeps canonical mode and documents a line limit. The spec does not cover the CLI, and Appendix A records only that raw mode is not used.

**Reply.**
> This is true, and on macOS the effect is worse. With a pseudo-terminal in canonical mode, `MAX_CANON` is 1024, and a line of 1,024 bytes or more never reaches `chat-terminal.ts` because the driver drops the rest of the line and Enter, so `spindle chat` waits with no message until Ctrl-C. We measured this on macOS on Node and Bun but not on Linux. The fix is in PR #__ of this stack.

---

## PR 10, PRRT_kwDOV8Uz-c68k8-1: `cli/chat.ts`, a signal during thread creation hooks

**Where.** `packages/runtime/src/cli/chat.ts:346`. `openThread` runs before the `uninterruptibleMask` that prints the resume line (lines 347-372). Inside it, `createThread` (`execution/trigger.ts:52-59`) commits the thread and then awaits `after_thread_created`, and only after that does `openThread` print `thread <id>` (`chat.ts:84-85`). In `platform/interrupts.ts:20-21`, SIGTERM and SIGHUP always interrupt the main fiber. So does SIGINT when no keyboard listener exists, and none exists before `converse` starts.

**True?** Yes. Script: `scratch/t11/signal_during_hook.py`, with project `scratch/t11`, whose agent has an 8-second `after_thread_created` hook. `chat assistant --db ./chat.db --script reply.json` runs on a pseudo-terminal, and the signal comes 2 seconds in. For Ctrl-C typed at the terminal, SIGTERM and SIGHUP, on Node and on Bun, the process exits 130 and prints neither the thread id nor a resume line. `sqlite3 chat.db "select id from threads"` shows the thread was stored each time. `spindle run assistant -m hi --db ./run.db` has the same gap on Node: it exits 130 with no id, and the thread is stored.

**How much.** Blocks. The command exits without its resume line while a durable thread exists. Plan Appendix A (`docs/plans/m1-core-loop.md:927`) promises the resume line "after the thread opens", and that does not cover this window. It needs a slow creation hook and a signal inside it, so the window is narrow.

**Smallest fix.** Give `createThread` in `execution/trigger.ts` an optional `onCreated(id)` effect, run after `store.createThread` and before `observeHooks` (about 4 lines). In `chat.ts`, pass a callback that prints `thread <id>` and records the id, and move the resume-line block so it runs whenever an id has been recorded, interrupted or not. For example, wrap `openThread` and `converse` in one `Effect.exit` inside the mask (about 15 lines). `run.ts:58-60` needs the same `onCreated` for its `thread <id>` line. Pin it with a case in `test/cli/chat-interrupt.test.ts`: a fixture with a slow `after_thread_created` hook, SIGTERM and Ctrl-C during the hook, expecting `thread <id>` and `resume with …` on stderr.

**Reply.**
> This is still true. `openThread` at `cli/chat.ts:346` runs outside the block that prints the resume line, and `createThread` commits the thread before it awaits `after_thread_created`. A Ctrl-C, SIGTERM or SIGHUP during a slow hook exits 130 with neither the id nor the resume command, on Node and on Bun, and `spindle run --db` has the same gap. The fix is in PR #__ of this stack.

---

## PR 11, PRRT_kwDOV8Uz-c68nmVM: `platform/shared.ts`, `isMain` and preserved symlinks

**Where.** `packages/runtime/src/platform/shared.ts:10-16`. The fallback compares `meta.url` with `import.meta.resolve(pathToFileURL(argv[1]))`.

**True?** Yes for the fallback, which I simulated because I had no Node without `import.meta.main`. Script: `scratch/t12/real.mjs` behind the symlink `scratch/t12/link.mjs`, calling the built `isMain` with `{ url: import.meta.url, main: undefined }`. On Node 22.22.3 it returns `true` with no flag, `false` with `--preserve-symlinks`, `false` with `--preserve-symlinks-main`, and `false` with `NODE_OPTIONS=--preserve-symlinks`. Bun returns `true` with and without its flag. Node 22.22.3 and Bun 1.4.5 both have `import.meta.main = true`, so the real CLI on this machine never reaches the fallback. The package's engine floor is `node >=22.19.0` (`packages/runtime/package.json:8`). Node 22.19 has `import.meta.main`, so the fallback runs only on Node 23.x and 24.0–24.1. Separately, a symlinked entry outside the package fails to load at all under `--preserve-symlinks-main`, with `ERR_PACKAGE_IMPORT_NOT_DEFINED` for `#platform`, even on Node 22.22.3. Under the pnpm layout, `--preserve-symlinks` fails with `ERR_MODULE_NOT_FOUND`. So fixing `isMain` would not make the `-main` flag work for a global bin symlink.

**How much.** Record. It needs Node 23 or 24.0–24.1 together with a symlink flag, which ordinary use does not produce. The result is a silent exit 0.

**Smallest fix.** In the fallback, compare real paths: `realpathSync(fileURLToPath(meta.url)) === realpathSync(entry)`, with a `try` that returns `false`. That is about 4 lines. Pin it with a `test/platform.test.ts` case that calls `isMain` with `main: undefined` through a symlinked entry, in child processes with each flag.

**Reply.**
> The fallback comparison in `platform/shared.ts:15` does return false under `--preserve-symlinks` or `--preserve-symlinks-main`. We confirmed that by calling it with `import.meta.main` unset through a symlink. Node 22.19, the package's minimum, has `import.meta.main`, so only Node 23 and 24.0–24.1 reach the fallback. The fix is in PR #__ of this stack.

---

## PR 12, PRRT_kwDOV8Uz-c68nmJH: `waitForAdmission` resolves after its limit

**Where.** `packages/conformance/src/scenarios/harness.ts:195-200`. Its callers are Q34 (`scenarios/queue/termination.ts:176`), a delivery scenario (`scenarios/queue/delivery.ts:382`) and a holder-lifecycle scenario (`scenarios/ownership/holder-lifecycle.ts:96`).

**True?** Yes for the helper, which I ran: `scratch/t13-wait.ts`. With a condition that is never true, it resolves after 500 polls, 5,729 ms on Node and 5,744 ms on Bun. That Q34 could then pass without testing already-waiting sends I reasoned, not ran. If the two sends were not admitted within the limit, the test terminates the thread first, and a send admitted after termination is refused with `ThreadTerminated` (ownership rule 9 and the termination row of the design note). That matches what Q34 asserts.

**How much.** Record. It weakens the tests only on a machine slow enough that admission takes over 5 seconds. No user meets it.

**Smallest fix.** After the loop, add `throw new Error("the admission did not happen within 500 polls")`. That is 1 line. The three existing callers pin it, because each would fail instead of passing quietly.

**Reply.**
> This is still true. `waitForAdmission` in `conformance/src/scenarios/harness.ts:195` returns normally after 500 polls whether or not the condition held, so Q34 could terminate the thread before both sends are queued. The fix, a throw after the loop, is in PR #__ of this stack.

---

## What I could not judge

- **Linux terminal behavior (PRRT_kwDOV8Uz-c68hRuo).** I measured only macOS, where the limit is 1,024 and the line is withheld entirely. The comment's Linux figure of 4,095 and its "truncated, then delivered" behavior are not checked here.
- **A real provider's response to an unpaired call (PRRT_kwDOV8Uz-c68gLtH).** With no real model and no network, "the provider rejects the request" is reasoned from the chat-completions format and not run.
- **Node 23 and 24.0–24.1 (PRRT_kwDOV8Uz-c68nmVM).** No such Node is installed, so I simulated the fallback by calling `isMain` with `main` unset rather than running the CLI on those versions.
- **Q34 passing without exercising waiting sends (PRRT_kwDOV8Uz-c68nmJH).** I reasoned this and did not force a slow admission.
- **Bun for the cyclic-metadata script (PRRT_kwDOV8Uz-c68bKYx).** I ran it on Node only. The code path is platform-independent JavaScript.
- **Bun's `node:readline` in terminal mode,** which the proposed fix for the chat terminal would rely on. I did not check it.

## Processes

Before writing this report I listed every process whose command line holds `/tmp/structure/threads/scratch` or the worktree path. None was a process I started. The only two matches were this agent's own host process (`claude … --add-dir=<worktree>`) and its launcher shell, both started by T3 Code. So the list of my processes is empty, and nothing needed killing.
