#!/usr/bin/env node
import fs from "node:fs"
import path from "node:path"

const conformance = path.join(import.meta.dirname, "../packages/conformance")
const requirementsFile = path.join(conformance, "requirements.json")
const ledgerFile = path.join(conformance, "ledger.json")

const DRAFT = "The Users page is a Draft in spec 0.2.0."
const EXAMPLE = "The statement is part of an example prompt for a coding agent, not a requirement."

// The M1 rules follow the sections that docs/plans/m1-core-loop.md gives to M1-2 through M1-7, and later
// work follows docs/plans/milestones.md. The plan names no milestone for infrastructure:providers, specification:providers,
// most of specification:tools, or some sections of threads, hooks, and messages, so those rules are judgment calls.
const RULES = [
  ["specification:users", undefined, "later", "deferred", DRAFT],
  ["getting-started:examples", undefined, "none", "not-testable", EXAMPLE],
  ["distribution:packaging", /^Packed Thread Endpoints$/, "M4"],
  ["distribution:packaging", undefined, "M1"],
  ["infrastructure:providers", undefined, "M7"],
  ["infrastructure:runtime", /^1\.1 /, "M4"],
  ["infrastructure:runtime", /^8\.[12] /, "M3a"],
  ["infrastructure:runtime", /^(7|8)\./, "M3b"],
  ["infrastructure:runtime", /^13\. /, "M7"],
  ["infrastructure:runtime", /^14\.\d+ (Runtime Semantics|Capacity and Errors)$|^14\. Durable Key-Value Store$/, "M1"],
  ["infrastructure:runtime", /^14\./, "M6"],
  ["infrastructure:runtime", /^15\. /, "M5"],
  ["infrastructure:runtime", undefined, "M1"],
  ["specification:agents", /^6\. /, "M3b"],
  ["specification:agents", undefined, "M1"],
  ["specification:effects", undefined, "M4"],
  ["specification:handlers", /^2\. /, "M1"],
  ["specification:handlers", undefined, "M2a"],
  ["specification:hooks", /^(2\.4|6\.3) /, "M3b"],
  ["specification:hooks", undefined, "M1"],
  ["specification:models", /^(1|6)\./, "M1"],
  ["specification:models", undefined, "M7"],
  ["specification:prompts", /^(2\.1|3\.3) /, "M2b"],
  ["specification:prompts", undefined, "M1"],
  ["specification:providers", /^(1\.3 |Config Slots$|Method Overrides$)/, "M7"],
  ["specification:providers", undefined, "M1"],
  ["specification:subagents", undefined, "M3b"],
  ["specification:threads", /^6\.[23] /, "M2a"],
  ["specification:threads", /^(2|6)\./, "M2b"],
  ["specification:threads", /^7\.4 /, "M7"],
  ["specification:threads", /^9\.1 /, "M3a"],
  ["specification:threads", /^(8|9)\./, "M3b"],
  ["specification:threads", /^5\./, "M5"],
  ["specification:threads", undefined, "M1"],
  ["specification:threads/client-api", undefined, "M5"],
  ["specification:threads/code-execution", undefined, "M6"],
  ["specification:threads/decisions", undefined, "M4"],
  ["specification:threads/endpoints", undefined, "M4"],
  ["specification:threads/execution-state", /^4\.4 /, "M5"],
  ["specification:threads/execution-state", undefined, "M1"],
  ["specification:threads/filesystem", undefined, "M3a"],
  ["specification:threads/messages", /^1\.1 /, "M3b"],
  ["specification:threads/messages", undefined, "M1"],
  ["specification:threads/runtime-streams", undefined, "M7"],
  ["specification:tools", /^1\. /, "M6"],
  ["specification:tools", /^(2|3)\./, "M2b"],
  ["specification:tools", /^6\. /, "M3a"],
  ["specification:tools", undefined, "M1"],
  ["specification:type-registry", undefined, "M7"],
]

const seed = ({ page, section }) => {
  const rule = RULES.find(([p, pattern]) => p === page && (pattern === undefined || pattern.test(section)))
  if (rule === undefined) throw new Error(`No milestone rule matches ${page} section "${section}"`)
  const [, , milestone, status = "planned", reason = ""] = rule
  return { status, milestone, tests: [], reason }
}

const requirements = JSON.parse(fs.readFileSync(requirementsFile, "utf8"))
const current = fs.existsSync(ledgerFile) ? JSON.parse(fs.readFileSync(ledgerFile, "utf8")) : {}
const ledger = Object.fromEntries(requirements.map((r) => [r.id, current[r.id] ?? seed(r)]))
const added = requirements.filter((r) => current[r.id] === undefined).length
for (const [id, entry] of Object.entries(current)) ledger[id] ??= entry
fs.writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, "\t")}\n`)
console.log(`added ${added} ledger entries, ${Object.keys(ledger).length} total`)
