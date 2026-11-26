import { definePrompt } from "@standardagents/spec"

export default definePrompt({
  name: "bench_hooks",
  toolDescription: "Calls a tool that returns at once, with a no-op hook at every position",
  model: "lane",
  prompt: "Call noop.",
  tools: ["noop"],
  includeChat: true,
  hooks: [
    "noop_created",
    "noop_system",
    "noop_filter",
    "noop_prefilter",
    "noop_before_create",
    "noop_after_create",
    "noop_before_update",
    "noop_after_update",
    "noop_before_store",
    "noop_success",
    "noop_failure",
    "noop_started",
    "noop_done",
  ],
})
