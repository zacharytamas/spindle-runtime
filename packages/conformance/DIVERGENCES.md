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

## Limits that Spindle sets where the spec allows one

Runtime section 14.2 lets a runtime cap key length, value size, and the number of keys, and asks that each cap be documented with the runtime. This section is that record. It is not a disagreement between the spec and the package.

- **Keys must be well-formed Unicode.** A key that holds a lone UTF-16 surrogate, such as `"\ud800"`, fails `setValue` and `getValue` with `KeyNotWellFormed`. SQLite stores a key as UTF-8, and UTF-8 has no encoding for a lone surrogate. Both drivers write U+FFFD in its place, so the keys `"\ud800"` and `"\ud801"` would read and overwrite each other. `packages/runtime/test/store/contract.test.ts > ThreadStore > key-value store > a key that is not well-formed Unicode fails with KeyNotWellFormed and never aliases another key` shows it.
- **A value may nest at most 1000 levels.** `setValue`, message `metadata` and `attachments`, thread `arguments`, and queue entries fail with `ValueNotJson` when an object or array sits inside more than 1000 others. Without the cap, a deeper value overflowed the stack with a raw `RangeError` at about 5,000 levels on Node and 20,000 on Bun. `packages/runtime/test/store/contract.test.ts > ThreadStore > key-value store > setValue fails with ValueNotJson, not a thrown error, for a getter that throws or a value nested too deep` shows it.
- **Text is stored as well-formed Unicode.** A lone UTF-16 surrogate in a message's text fields, a thread's agent name, or a run status reason is replaced with U+FFFD when the record is written, and the write returns the replaced text. UTF-8 has no encoding for a lone surrogate, so the database could not hold it, and a write that returned the original would disagree with every later read. Key-value keys are stricter and fail, because two replaced keys would collide.
- **A value must be plain JSON data.** An object is accepted when it has no prototype or when its prototype has none itself, which covers an object literal from any JavaScript realm. A `Date`, a `Map`, a class instance, or any object that has a `toJSON` method, its own or inherited, fails with `ValueNotJson`, and so does `NaN`, `Infinity`, a `BigInt`, a function, or `undefined` inside an array. Runtime section 14.1 lets a runtime reject a value that JSON cannot represent. `JSON.stringify` would accept these values and store something different from what the caller passed, so a later read would not return the value that was written. A member whose key is a symbol is left out, as `JSON.stringify` leaves it out.
