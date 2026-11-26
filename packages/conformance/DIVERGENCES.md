# Divergences

This file lists each place where the spec text and `@standardagents/spec` disagree. The spec text decides behavior. The package decides signatures. The operator decides which entries to report upstream.

Add one section per disagreement, with these lines:

- **Spec.** The page, the section, and the requirement id from `requirements.json`.
- **Package.** The symbol in `@standardagents/spec` and its version.
- **Disagreement.** What each side says.
- **Spindle.** What Spindle does, and the test that shows it.

M1-1 uses one symbol from the package, `SPEC_VERSION`, and its value `0.2.0` matches the version folder that `spec.lock.json` pins.

Some sections record a point that the spec text leaves open. Spindle takes the stricter reading there and reports an issue, so that a later spec answer can only relax the check.

## User hook types

- **Spec.** Hooks section 1.2, `specification:hooks:de7e582d`. The `hook` property must name one of the 14 types in section 1.1.
- **Package.** `defineHook` in `@standardagents/spec` 0.45.13 also accepts `user_client_attached`, `user_client_detached`, and `user_value_changed`.
- **Disagreement.** The three user hook types come from the Users page, which is a Draft in 0.2.0. Section 1.1 does not list them.
- **Spindle.** A hook with one of these types gets `hook_type_invalid`. The `hook-fields` case in `packages/runtime/test/registry/validate.test.ts` shows it with `agents/hooks/user_value.ts`.

## Environment parts in a structured prompt

- **Spec.** Prompts sections 2.3 and 9.1, `specification:prompts:eb5bda3e`. A structured prompt holds text parts and include parts.
- **Package.** `PromptPart` in `@standardagents/spec` 0.45.13 also has `PromptEnvPart`, `{ type: 'env', property }`.
- **Disagreement.** The spec text names two part types. The package type names three.
- **Spindle.** The part union is a signature, so Spindle accepts an env part with a non-empty `property`. Any other part type gets `prompt_content_invalid`, as the `prompt-required-fields` case in `packages/runtime/test/registry/validate.test.ts` shows.

## Model names with spaces

- **Spec.** Models section 6, `specification:models:debf8c4d`. A model name must not contain spaces.
- **Package.** `defineModel` in `@standardagents/spec` 0.45.13 checks only that the name is a non-empty string.
- **Disagreement.** The package accepts `"spaced name"`. The spec rejects it.
- **Spindle.** A name with white space gets `model_name_invalid`. The `model-fields` case in `packages/runtime/test/registry/validate.test.ts` shows it.

## Which packed agents are entry points

- **Spec.** Packaging, PackedMeta and Visibility Rules, `distribution:packaging:e20305eb`. `__meta.entryAgents` lists the agents visible from outside the package.
- **Package.** The doc comment on `isVisibleInNamespace` in `@standardagents/spec` 0.45.13 says that its `isEntryPoint` argument means an agent with `exposeAsTool: true`.
- **Disagreement.** The spec ties visibility to `entryAgents`. The package comment ties it to `exposeAsTool`.
- **Spindle.** `resolve` passes `isEntryPoint` as true when the package's `__meta.entryAgents` lists the agent. `packages/runtime/test/registry/resolve.test.ts` shows it.

## A definition's identifier and its file name

- **Spec.** Agents section 2.1 and Prompts section 1.1 call `name` the unique identifier of an agent and of a prompt. Models section 3.2 says a fallback names another model "by their `name` property", and Prompts section 8 says "Hook IDs reference the `id` property from `defineHook({ hook, id, execute })`". Effects section 1.3 says "Effect names are file-based". Tools and handlers have no identifier field, and the Packaging example names them by their export keys.
- **Package.** No symbol covers it.
- **Disagreement.** The spec gives no rule for an identifier field that differs from the file name or from the packed export key.
- **Spindle.** The registry finds an agent, a prompt, or a model by its `name` and a hook by its `id`. It finds a tool, a handler, or an effect by its file name, or by its export key in a package. A `name` or `id` that differs from the file name or export key is legal, so it gets the warning `definition_name_mismatch` and never an error. Two definitions of one kind that declare the same identifier in one namespace get `definition_name_duplicate`, whatever their file names. The first owner of M1-2 used the file name for every kind and made a differing field an error. That rule rejected a hook that a prompt named by its `id`, which Prompts section 8 allows. The `name-mismatch`, `hook-fields`, and `duplicate-name` cases in `packages/runtime/test/registry/validate.test.ts` show the current rule.

## An agent in a prompt's tools without exposeAsTool

- **Spec.** Agents section 5 and Tools section 1. An agent with `exposeAsTool: true` that a prompt names in `tools` is a handoff. No page says what happens when the agent does not set `exposeAsTool`.
- **Package.** No symbol covers it.
- **Disagreement.** The spec leaves the point open.
- **Spindle.** A prompt `tools` entry that resolves to an agent without `exposeAsTool: true` gets `prompt_tool_agent_not_exposed`. The `agent-tool-not-exposed` case in `packages/runtime/test/registry/validate.test.ts` shows it.

## Message fields that the spec requires and the package marks optional

- **Spec.** `specification/threads/messages.md`, section 1, Message Structure. The table types `name`, `tool_calls`, `tool_call_id`, `tool_status`, `status`, `attachments`, `reasoning_content`, `reasoning_details`, `prompt`, `parent_id`, and the nine `subagent_*` fields as `T | null`, and `depth`, `silent`, and `metadata` as plain types, so each field is always present. Requirement ids include `specification:threads/messages:968989f2` (`name`), `specification:threads/messages:41278e5e` (`tool_call_id`), and `specification:threads/messages:e551bf33` (`depth`).
- **Package.** `Message` in `@standardagents/spec` 0.45.13 declares each of those fields optional, as in `name?: string | null` and `depth?: number`.
- **Disagreement.** The spec says a reader can rely on each field. The package lets a runtime leave it out.
- **Spindle.** The store returns every field of the spec's table on every message, with `null` for an absent value, `0` for `depth`, `false` for `silent`, and `{}` for `metadata`. The nine `subagent_*` fields are always `null` until M3 adds the child registry they project from. That record satisfies both types. `packages/runtime/test/store/contract.test.ts > ThreadStore > messages > appendMessages returns the stored records and getMessage reads each one back` asserts the full record.

## Stream chunks that only the package declares

- **Spec.** Providers section 6 lists the stream chunks, and its `finish` chunk carries `finishReason` and `usage` only. Messages section 1.3, `specification:threads/messages:7abccc72`, still requires the runtime to persist provider-specific reasoning data.
- **Package.** `ProviderStreamChunk` in `@standardagents/spec` 0.45.13 adds `reasoningDetails` to `finish`, `extraContent` to `tool-call-start` and `tool-call-done`, and the chunks `web-search-done` and `provider-tool-done`.
- **Disagreement.** Without the package's `reasoningDetails`, a streamed response has no way to carry the reasoning data that the spec requires Spindle to persist.
- **Spindle.** The chunk union is a signature, so Spindle reads all of them. It stores `finish.reasoningDetails` as `reasoning_details`, keeps `extraContent` in `metadata.tool_call_extra` and sends it back with the call, and counts the two provider-executed chunks without running anything. `packages/runtime/test/conformance.test.ts > step loop > S09 assembles one response from interleaved chunks and stores calls in first-seen order with JSON arguments` and `S27 treats provider-executed tools and generated images as parts of one response and runs nothing locally` show it.

## invokeTool and a target outside uses

- **Spec.** Tools section 2.1, `specification:tools:a403d2a5`. "`invokeTool()` returns an error result for an undeclared target."
- **Package.** The doc comment on `DefineToolOptions.uses` in `@standardagents/spec` 0.45.13 says "At runtime, attempts to call unlisted items will throw an error."
- **Disagreement.** The spec text returns an error result. The package comment throws.
- **Spindle.** `invokeTool` returns `{ status: "error" }` for a target outside a supplied `uses` list and never throws for it, and `queueTool` throws, as both sides agree. `S16 answers a call to an unoffered or unknown tool with an error result and enforces uses in invokeTool` and `Q10 lets queueTool and invokeTool reach a target an omitted or listing uses allows, and refuses an empty or other list` show it.

## Members of a provider request and a prompt that only the package declares

- **Spec.** Providers section 2 lists the fields of `ProviderRequest`, and Prompts section 1.2 lists the optional properties of a prompt.
- **Package.** `ProviderRequest` in `@standardagents/spec` 0.45.13 adds `reasoning.levels` and `user`, and `PromptDefinition` adds `historyLimit` and `providerOptions`.
- **Disagreement.** The spec text has none of the four, although Providers section 2.1 merges `prompt.providerOptions`.
- **Spindle.** A request carries `reasoning.levels` from the model's `capabilities.reasoningLevels` whenever the prompt sets a level, because Providers section 2.2 maps a level to the model's declared levels. Spindle merges `prompt.providerOptions` after the model's. It sends no `user` and ignores `historyLimit`, which would window the execution history that Execution State section 2.2 requires in full. `filter_messages` also gets the whole snapshot, not the newest window that the package's doc comment for it describes. `S06a merges provider options from the model and then the prompt, later keys winning` and `S06b carries the prompt's reasoning level, token limit, and exclusion with the model's declared levels` show the first two.

## The name of a message that prefilter_llm_history returns

- **Spec.** Hooks section 3.3, `specification:hooks:5cf7c4b6`, says that the array `prefilter_llm_history` returns must be the provider request history. Hooks section 6.4 gives `LLMMessage` an optional `name` and any other key.
- **Package.** `ProviderSystemMessage`, `ProviderUserMessage`, and `ProviderAssistantMessage` in `@standardagents/spec` 0.45.13 have no `name` and no other extra key. Only `ProviderToolMessage` has `toolName`.
- **Disagreement.** The spec lets a hook name the speaker of a message, and the provider types that every provider receives have no place for it.
- **Spindle.** The provider message types are a signature, so Spindle sends every field they hold and drops `name` on a system, user, or assistant message, and every key that no provider message type has. `H11b sends every field of the array prefilter_llm_history returns that a provider message can hold` shows the fields that are kept.

## Execution state in a hook at rest

- **Spec.** Hooks section 2.1 says `execution` is "Always present in hooks", and section 2.2 says `state.execution` is always available. Execution State section 1, `specification:threads/execution-state:048a4525`, makes it null at rest, and Messages section 3.1, `specification:threads/messages:a63f8e52`, runs the create hooks for an injection at rest.
- **Package.** `ThreadState.execution` in `@standardagents/spec` 0.45.13 is `ExecutionState | null`, and the doc comment of `HookContext` checks `if (state.execution)` before it reads the step count.
- **Disagreement.** Hooks section 2 says that every hook sees an execution. Execution State section 1 and the package let a hook at rest see null.
- **Spindle.** A hook that runs during an execution sees that execution. A hook at rest sees `execution` as null. That covers `after_thread_created`, the create and update hooks of a write outside an execution, and the create hooks of the human's message, which Spindle stores before the execution starts. The example in Hooks section 8.6 reads `state.execution.flowId`, so it throws at rest, and Spindle logs the failure and goes on. `M2 runs the agent's create hooks for a message injected at rest and makes it readable before any run` and `H21 calls each of the thirteen hook types with ThreadState first, its own arguments, and the context last` show it.

## The message that a create hook receives

- **Spec.** Hooks section 6.1 gives `HookMessage` ten fields. Hooks section 4.1 types `before_create_message` with `Message`, and Messages section 1 lists the whole record.
- **Package.** `HookMessage` in `@standardagents/spec` 0.45.13 is `Message`.
- **Disagreement.** Section 6.1 shows fewer fields than the type that the hook gets.
- **Spindle.** Every hook that gets a message gets the whole `Message`, with the `id` and `created_at` that the store will keep. `H21 calls each of the thirteen hook types with ThreadState first, its own arguments, and the context last` shows the fields, and `M1 runs each create hook once for a message a tool injects, and later tools and hooks see the stored row` shows that the id and the time match the stored row.

## Metadata written as JSON text

- **Spec.** Messages section 1 types `metadata` as `Record<string, unknown>`. The example in Hooks section 8.6 returns `metadata: JSON.stringify({ ... })`.
- **Package.** `Message.metadata` in `@standardagents/spec` 0.45.13 is `Record<string, unknown>`.
- **Disagreement.** The spec's own example writes a string where the table and the type ask for an object.
- **Spindle.** A create or update hook may return `metadata` as a string that holds a JSON object, and Spindle stores that object. Any other string makes the return invalid. `H9b stores a hook's own id, time, and JSON metadata text, and refuses an id another message holds or an update key it adds` shows it.

## Keys that a before_update_message hook adds

- **Spec.** Hooks section 4.3 types the updates as `Record<string, unknown>` and says that the returned object must be used for the update. Messages section 5 updates `content` and `metadata`.
- **Package.** `MessageUpdates` in `@standardagents/spec` 0.45.13 holds `content` and `metadata`. The doc comment of `before_update_message` gives an example that returns `{ ...updates, updated_at: Date.now() }`.
- **Disagreement.** The package's example adds a key that `MessageUpdates` has no place for.
- **Spindle.** A returned key other than `content` and `metadata` that the hook added or changed makes the return invalid, so the hook fails and `updateMessage` rejects with no change. Storing the update without that key would report a change that never happened. A key that the caller passed and the hook kept as it was is ignored, as it is without hooks. `H9b stores a hook's own id, time, and JSON metadata text, and refuses an id another message holds or an update key it adds` shows both cases.

## The arguments of queueTool

- **Spec.** Threads section 1.2.2, `specification:threads:304b015d`, lists `queueTool(toolName, args)`.
- **Package.** `ThreadState.queueTool` in `@standardagents/spec` 0.45.13 requires `args`, and `UsesConstrainedState.queueTool` and `invokeTool` make it optional.
- **Disagreement.** The package's two types for one method disagree about the second argument.
- **Spindle.** `queueTool` treats missing arguments as `{}` and throws `InvalidArguments` for arguments that are not an object. It throws for a name that resolves to no function tool too, so that nothing waits in the queue that could never run. `Q08 runs a tool queued to an idle thread with no model call asking for it, then the model sees the call and result` shows the call.

## invokeTool at rest

- **Spec.** Threads section 3.2, `specification:threads:a1ac0a36`, says only "Invoke a tool and wait for the result".
- **Package.** The doc comment of `ThreadState.invokeTool` in `@standardagents/spec` 0.45.13 says that a thread that is not executing gets "a minimal execution context for the tool".
- **Disagreement.** The package describes a behavior at rest that the spec text does not require.
- **Spindle.** `invokeTool` from a ThreadState at rest returns an error result that says it needs a calling tool and its `uses` list, as it did before M1-6. A tool inside an execution invokes another tool as before. A minimal execution at rest needs a decision about the run status and the claim that it would take, and the M1 review owns that choice.

## The reason of a running thread

- **Spec.** Execution State section 4.1, `specification:threads/execution-state:a46f561c` and `:ce0b6d35`, says that `reason` is `null` while a thread runs and for a thread that never ran.
- **Package.** `ThreadStatus.reason` in `@standardagents/spec` 0.45.13 is optional, `reason?: string | null`.
- **Disagreement.** The package lets a runtime leave the field out where the spec gives it a value.
- **Spindle.** `status()` always returns `reason`, as `null` in those two cases. `R15 reads the run status at rest, inside a run, after success and failure, and from another session` shows it.

## Limits that Spindle sets where the spec allows one

Runtime section 14.2 lets a runtime cap key length, value size, and the number of keys, and asks that each cap be documented with the runtime. Threads section 2.3 says that secret values should be redacted from tool output and logs, and leaves the method to the runtime. This section records the limits of both. It is not a disagreement between the spec and the package.

- **Keys must be well-formed Unicode.** A key that holds a lone UTF-16 surrogate, such as `"\ud800"`, fails `setValue` and `getValue` with `KeyNotWellFormed`. SQLite stores a key as UTF-8, and UTF-8 has no encoding for a lone surrogate. Both drivers write U+FFFD in its place, so the keys `"\ud800"` and `"\ud801"` would read and overwrite each other. `packages/runtime/test/store/contract.test.ts > ThreadStore > key-value store > a key that is not well-formed Unicode fails with KeyNotWellFormed and never aliases another key` shows it.
- **A value may nest at most 1000 levels.** `setValue`, message `metadata` and `attachments`, thread `arguments`, and queue entries fail with `ValueNotJson` when an object or array sits inside more than 1000 others. Without the cap, a deeper value overflowed the stack with a raw `RangeError` at about 5,000 levels on Node and 20,000 on Bun. `packages/runtime/test/store/contract.test.ts > ThreadStore > key-value store > setValue fails with ValueNotJson, not a thrown error, for a getter that throws or a value nested too deep` shows it.
- **Text is stored as well-formed Unicode.** A lone UTF-16 surrogate in a message's text fields, a thread's agent name, or a run status reason is replaced with U+FFFD when the record is written, and the write returns the replaced text. UTF-8 has no encoding for a lone surrogate, so the database could not hold it, and a write that returned the original would disagree with every later read. Key-value keys are stricter and fail, because two replaced keys would collide.
- **A value must be plain JSON data.** An object is accepted when it has no prototype or when its prototype has none itself, which covers an object literal from any JavaScript realm. A `Date`, a `Map`, a class instance, or any object that has a `toJSON` method, its own or inherited, fails with `ValueNotJson`, and so does `NaN`, `Infinity`, a `BigInt`, a function, or `undefined` inside an array. Runtime section 14.1 lets a runtime reject a value that JSON cannot represent. `JSON.stringify` would accept these values and store something different from what the caller passed, so a later read would not return the value that was written. A member whose key is a symbol is left out, as `JSON.stringify` leaves it out.
- **Redaction finds a secret value as written and once JSON-escaped.** It does not find a transformed copy, such as base64 or URL encoding. There is no length floor, so a secret that is very short or that is a common word is also removed from ordinary words in tool output and in printed lines. For the same reason, a run fails before its first request when its system prompt holds such a secret as part of a word. `packages/runtime/test/execution/redact.test.ts` and `S26b redacts a secret of any length from stored tool results, later requests, and run errors` show it.
- **Redaction replaces a secret wherever a tool or a hook writes it.** The result text, the error text, `error_data`, the name and description of an attachment, and the content and metadata of a message that a tool or a hook injects or edits each lose every secret as written and JSON-escaped, with a plain replacement over the whole text. Property names are not an exception, so `{"<secret>":true}` is stored as `{"[redacted]":true}`. Two metadata keys that differ only in a secret become one key, and the later value wins. Redaction runs after Spindle joins the error text, the result text, and its own notes into the stored content, so a secret that is a word of a note is removed too. The runtime reads what it needs from a tool result before redaction: the value that `stopToolResponseProperty` names is found even when a secret is part of the property name, and the run outcome reports that value redacted. The fields that the runtime reads back as identifiers keep their values: the tool status, the call id, the tool name, `error_code`, and the path of an attachment. A secret in a number or a boolean stays, because redaction changes text only. `S18b reads the stop property before redaction, so a secret inside the property name cannot hide it`, `S26g replaces a secret wherever a tool writes it, in property names and in nested JSON text alike`, `S26h redacts a stored result after Spindle adds its own note, so a secret that is a word of the note is removed`, and `S26i redacts a secret that a tool or a hook writes as a property name, in a result, an injection, and an edit`, and `H22b redacts a write with the secrets that its hooks learned before the write was stored` show it.
- **A message that a tool or a hook writes is tool output.** When a tool or a hook calls `injectMessage` or `updateMessage`, the content and the metadata, its keys included, lose every secret before the message is stored. Redaction runs after the create or update hooks of that write, with every secret the execution knows by then, so a value that a hook learns to be secret while the write is in flight is removed too. The keys `error_code` and `error_data`, under which Spindle stores a tool error, keep their names. The human's messages and the model's responses are stored as written, and a field that a hook changes on them is redacted like tool output. `S26f redacts the text a tool writes into the thread and keeps what the human and the model wrote` shows it.
- **The model's response is stored as returned.** Its text, reasoning text, reasoning details, and tool calls are not redacted, because the stored arguments are what the model sent and the next request shows them. The tool gets the arguments after its schema validates them, so a schema that transforms a value, such as `z.string().trim()`, gives the tool a value that differs from the stored one. `spindle run` redacts each line when it prints it, so a printed line holds no known secret value. `S26c stores the model's reply as returned and runs the tool with the arguments it stored` shows it.
- **A tool call's arguments pass through JavaScript numbers.** The package's chunk type gives a call's arguments as an object, so `openaiCompatible` parses the argument text with `JSON.parse`, and the loop stores that object with `JSON.stringify`. An integer beyond 2 to the power of 53, such as `9007199254740993`, loses precision, so the stored arguments, the value the tool gets, and the next request all hold `9007199254740992`. A tool that needs a large identifier takes it as a string.
- **The system prompt check knows the secrets that the execution can resolve.** Every value from the runtime instance environment is secret, because the operator supplies it and no declaration can vouch for it, so an env part whose variable resolves from the instance fails the run, even when the prompt declares that variable as text. A value from an agent, prompt, or tool entry default is text unless a declaration or the provider config marks its name secret. Before the first request the execution learns the secret values of the provider config, the value of every name marked secret, and the instance value of every variable that the prompt or one of its tools declares, and the finished system prompt may hold none of them. Spindle cannot list the instance environment, so an instance value that nothing declares is checked only from the step after a tool reads it. `S26d fails before any request when a secret variable or a secret value reaches the finished system prompt` and `S26e treats every instance value as secret, so a text variable from the instance never reaches the system prompt` show the checks.
- **A request hook can put a secret into a message that is not a system message.** After the last request hook, Spindle checks every system message of the request as it checks the rendered system prompt, and fails the run before the model call when one holds a secret value that the execution knows. A message of another role that `filter_messages` or `prefilter_llm_history` returns is sent as the hook wrote it, a secret included. That message is text that the developer's hook wrote for the model, as a tool's description is, and Spindle does not rewrite it. `I6 fails the run before the model call when a request hook adds a system message that holds a secret` shows the check.
- **A hook call has a time limit.** Hooks section 1.2 asks for a timeout and names none. One hook call may run for 30 seconds. `spindle run --hook-timeout <seconds>` or the `HookTimeout` reference sets another limit. A hook past its limit counts as a failed hook of its type, and Spindle discards what it returns, even when it blocked the thread and returned before the timer fired. Spindle cannot stop user code, but every later call through the hook's ThreadState rejects with `HookExpired`, which says that the hook's time limit passed. The log line says that Spindle cannot undo anything else the hook does. The log line holds the hook's id, its type, and what Spindle did, and never the hook's arguments or the text of its error. `H15 goes on without a hook that does not settle in time and logs only its id, never its error text`, `H15b discards a return that comes after the time limit and refuses later calls from that hook's state`, and `packages/runtime/test/cli/run.test.ts > spindle run > goes on after --hook-timeout and prints the hook's id on standard error without the message` show it.
- **Nested hook writes have a depth limit.** Hooks section 3.4 runs the create hooks for a message that a hook injects, so a `before_create_message` hook that injects runs again for its own message, and nothing in the spec bounds the chain. A write that the loop, a tool, or a caller at rest makes has depth 0, and a write from the ThreadState of a hook that a write of depth d called has depth d + 1. A write deeper than 8 fails with `NestedWriteTooDeep`, which names the hook, and the `NestedWriteLimit` reference sets another limit. `H15c refuses a write nested deeper than the limit and names the hook that made it` shows it.
- **A prefilter_llm_history hook returns messages that provider messages can hold.** The package types `LLMMessage.role` as any string and `content` as a string, null, or any array. A provider request holds the four provider message types, so Spindle checks each returned message against the one its role names. A system message has string content. A user message has string content or content parts of the package's `ContentPart` union. An assistant message has string or null content, tool calls whose arguments are a JSON object or the text of one, and reasoning, with each reasoning detail in the package's `ProviderReasoningDetail` shape. An array with a hole in it is not a list of messages, parts, calls, or details. A tool message has a call id and string content or content parts, and string content when its `tool_status` is `"error"`. A message that breaks one of these rules, such as an assistant message whose content is an array with an image, makes the return invalid, and Spindle keeps the array that the hook was given rather than flatten or drop part of it. Every field that a provider message type holds is sent as returned. The hook sees a tool error as a tool message with `tool_status: "error"`, the field that a stored tool message uses, and Spindle reads it back the same way. `H11b sends every field of the array prefilter_llm_history returns that a provider message can hold` and `H12 runs started and done once per call, the success or the failure branch by outcome, and before-store on both` show it.
- **One execution per thread.** Each claim identifies a process by its holder record and process id. Recovery checks that process under the SQLite writer lock. A missing process or holder settles the execution as failed with `execution_lost`. A live process or an inconclusive probe keeps the claim. The supervisor polls for external termination and recovery every 250 ms. Elapsed time cannot displace a holder. The operator can use `spindle recover <thread>` to repair a dead holder and add `--force` to displace a frozen process or a reused process id.
- **Callback lifetime.** An abort keeps the claim while a callback is still running. Queued work resumes after cleanup. Termination, orderly process exit, and forced recovery end that wait. A tool or hook handle expires when its callback returns, rejects, times out, or is aborted. Each write checks the flow and handle inside its transaction.
- **Call identity.** Messages carry a runtime-owned `flow_id`. A tool result also carries `caller_seq`, the sequence of its caller. Recovery, request assembly, and deletion use this link. A caller with open calls in a running flow cannot be deleted.
- **A lost execution leaves the queue for the next trigger.** Recovery keeps every accepted queue entry and every committed message, and runs nothing again. Each call of the lost run that has no stored result gets an error result with this text. "Spindle lost the execution before it stored a result for this call. It does not know whether the tool ran, and it did not run the tool again." A run that fails, is aborted, or is terminated closes its open calls the same way, with a text that names the cause. These results go straight to the store without hooks, because the execution that owned the hooks has ended. `a process killed in a tool leaves the response and the first result, an error result for the open call, and the queue` shows it.
- **Queued input is not a message until the drain stores it.** Messages section 1 says that a message is `pending` while it is queued. Spindle keeps queued input in its queue, outside the message list, and the drain stores each entry as a `completed` message in the transaction that removes it from the queue. `getMessages` never lists queued input, and no stored message is `pending`.
- **A queued tool call is a call of the prompt side.** The drain stores the call in the prompt side's role with `metadata.queued` set to `true`, a call id that starts with `queued-`, and the tool's name as the prompt offers it, and then runs the tool and stores its result as for a model call, hooks included. The call and its result are in the next request.
- **Queued work.** Admission reads tool arguments into plain data and refuses a secret known to the calling handle in any key or string value. It redacts queued attachment names and descriptions. The drain keeps an unreadable entry with its original sequence and payload, marks it `failed_delivery`, and continues with pending entries. At the step cap, work that would otherwise extend the execution stays queued for the next trigger and the run settles with `max_total_steps`. With an empty queue, ordinary stop precedence applies. The human's message through `send` is stored as written.
- **queueMessage takes attachment references only.** A new file needs the thread file system, which arrives in M3, so `queueMessage` rejects an attachment that holds data.
- **injectMessage starts nothing.** Runtime section 2 calls a new message a trigger. Spindle reads a message from the human side, delivered through `send`, `spindle send`, or `spindle run`, as that trigger. `injectMessage` writes history and starts no execution, and it still works on a terminated thread, which takes no queued work or execution.
- **A waiting sender runs its own message.** When the run that a sender queued behind stops or fails and leaves the sender's message queued, the sender claims the thread and runs it, because the message is the sender's own request. After a lost run, the message waits for the next trigger. `queueMessage` does not wait, so its entry waits for the next trigger after a stop or a failure.
