#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const [target] = process.argv.slice(2)
if (target === undefined) {
  console.error("Usage: node packages/conformance/fixtures/generate-large.mjs <dir>")
  process.exit(2)
}

const COUNTS = { agents: 40, prompts: 40, tools: 40, models: 20, hooks: 20, handlers: 20, effects: 20 }

const files = {
  agents: (i) => `export default {
  name: "agent_${i}",
  sideA: { prompt: "prompt_${i}", subagents: [{ agent: "agent_${(i + 1) % COUNTS.agents}", as: "next_${i}" }] },
  sideB: { human: true },
  hooks: ["hook_${i % 20}"],
}
`,
  prompts: (i) => `export default {
  name: "prompt_${i}",
  toolDescription: "Prompt ${i}",
  model: "model_${i % 20}",
  prompt: [{ type: "text", content: "Prompt ${i}." }${i > 0 ? `, { type: "include", prompt: "prompt_${i - 1}" }` : ""}],
  tools: ["tool_${i}", "tool_${(i + 1) % 40}"],
}
`,
  tools: (i) => `export default {
  description: "Tool ${i}",
  args: null,
  execute: async () => ({ status: "success", result: "${i}" }),
}
`,
  models: (i) => `const provider = () => {
  throw new Error("The generated fixture does not call a provider")
}

export default { name: "model_${i}", provider, model: "fixture-model-${i}" }
`,
  hooks: (i) => `export default { hook: "after_create_message", id: "hook_${i}", execute: async () => {} }
`,
  handlers: (i) => `export default {
  [Symbol.for("standardagents.handler")]: true,
  description: "Handler ${i}",
  execute: async () => {},
}
`,
  effects: (i) => `export default ["Effect ${i}", null, async () => {}]
`,
}

let written = 0
for (const [kind, count] of Object.entries(COUNTS)) {
  const dir = path.join(target, "agents", kind)
  fs.mkdirSync(dir, { recursive: true })
  for (let i = 0; i < count; i++) {
    const name = `${kind.slice(0, -1)}_${i}`
    fs.writeFileSync(path.join(dir, `${name}.ts`), files[kind](i))
    written++
  }
}
console.log(`wrote ${written} definitions to ${target}`)
