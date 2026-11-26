#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import process from "node:process"

const USAGE = "Usage: node scripts/spec-requirements.mjs [--refresh] [--check]"
const flags = process.argv.slice(2)
if (flags.some((flag) => flag !== "--refresh" && flag !== "--check")) {
  console.error(USAGE)
  process.exit(2)
}
const refresh = flags.includes("--refresh")
const check = flags.includes("--check")

const conformance = path.join(import.meta.dirname, "../packages/conformance")
const lockFile = path.join(conformance, "spec.lock.json")
const requirementsFile = path.join(conformance, "requirements.json")

const KEYWORD = /\b(MUST NOT|MUST|SHOULD NOT|SHOULD|MAY)\b/
const LOWERCASE = /\b(must not|must|should not|should)\b/

const requirementId = (page, section, text) =>
  `${page}:${createHash("sha1").update(`${section}\n${text}`).digest("hex").slice(0, 8)}`

const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return entry.name.endsWith(".md") ? [full] : []
  })

const extract = (specDir) => {
  const slug = (file) =>
    path
      .relative(specDir, file)
      .replace(/\.md$/, "")
      .replace(/^(specification|infrastructure|distribution|getting-started)\//, "$1:")
  const requirements = []
  for (const file of walk(specDir).sort()) {
    const page = slug(file)
    let section = ""
    let fenced = false
    let block = []
    let blockLine = 0
    let blockKind = "paragraph"
    let lead = null
    let tableRow = 0
    const classify = (text) => {
      const upper = text.match(KEYWORD)
      const lower = !upper && text.match(LOWERCASE)
      return upper || lower ? { level: (upper ? upper[1] : lower[1]).toUpperCase(), rfc2119: Boolean(upper) } : null
    }
    const emit = (line, text, { level, rfc2119 }) =>
      requirements.push({ id: requirementId(page, section, text), page, line, section, level, rfc2119, text })
    const closeLead = () => {
      if (lead && !lead.used) emit(lead.line, lead.text, lead)
      lead = null
    }
    const flush = () => {
      if (!block.length) return
      const text = block.join(" ").replace(/\s+/g, " ").replace(/\*\*/g, "").trim()
      block = []
      if (blockKind === "row" && tableRow <= 2) return
      const own = classify(text)
      if (lead && (blockKind === "row" || (blockKind === "item" && !lead.rowsOnly))) {
        lead.used = true
        emit(blockLine, `${lead.text} ${text}`, own ?? lead)
        return
      }
      closeLead()
      if (!own) return
      if (blockKind === "row") emit(blockLine, text, own)
      else lead = { ...own, line: blockLine, text, used: false, rowsOnly: !text.endsWith(":") }
    }
    fs.readFileSync(file, "utf8")
      .split(/\r?\n/)
      .forEach((line, index) => {
        tableRow = /^\s*\|/.test(line) ? tableRow + 1 : 0
        if (/^\s*(```|~~~)/.test(line)) {
          flush()
          closeLead()
          fenced = !fenced
          return
        }
        if (fenced) return
        const heading = line.match(/^#{1,6}\s+(.*)$/)
        if (heading) {
          flush()
          closeLead()
          section = heading[1].trim()
          return
        }
        const item = /^\s*([-*]|\d+\.)\s+/.test(line)
        const row = /^\s*\|/.test(line)
        if (line.trim() === "" || item || row) flush()
        if (line.trim() === "") return
        if (!block.length) {
          blockLine = index + 1
          blockKind = item ? "item" : row ? "row" : "paragraph"
        }
        block.push(line.replace(/^\s*([-*]|\d+\.)\s+/, "").trim())
        if (row) flush()
      })
    flush()
    closeLead()
  }
  return requirements
}

const fetchSpec = ({ repository, commit, path: versionPath }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-spec-"))
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "inherit"] })
  try {
    git("init", "--quiet")
    git("fetch", "--quiet", "--depth", "1", repository, commit)
    git("checkout", "--quiet", "FETCH_HEAD")
    return extract(path.join(dir, versionPath))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const committed = fs.readFileSync(requirementsFile, "utf8")
const committedRequirements = JSON.parse(committed)
const requirements = refresh
  ? fetchSpec(JSON.parse(fs.readFileSync(lockFile, "utf8")))
  : committedRequirements.map((r) => ({ ...r, id: requirementId(r.page, r.section, r.text) }))
const output = `${JSON.stringify(requirements, null, "\t")}\n`

const seen = new Set()
const duplicates = []
for (const r of requirements) {
  if (seen.has(r.id)) duplicates.push(r.id)
  seen.add(r.id)
}
if (duplicates.length) {
  console.error(`Duplicate requirement ids: ${duplicates.join(", ")}`)
  process.exit(1)
}

if (check && output !== committed) {
  const before = new Set(committedRequirements.map((r) => r.id))
  for (const r of requirements) if (!before.has(r.id)) console.error(`added ${r.id}`)
  for (const id of before) if (!seen.has(id)) console.error(`removed ${id}`)
  console.error(
    "requirements.json differs from the extracted statements. Run node scripts/spec-requirements.mjs --refresh to rewrite it.",
  )
  process.exitCode = 1
}
if (refresh && !check) fs.writeFileSync(requirementsFile, output)

const byPage = new Map()
for (const r of requirements) {
  const row = byPage.get(r.page) ?? { rfc2119: 0, lowercase: 0 }
  row[r.rfc2119 ? "rfc2119" : "lowercase"] += 1
  byPage.set(r.page, row)
}
if (!check)
  for (const [page, row] of byPage)
    console.log(`${String(row.rfc2119).padStart(4)} ${String(row.lowercase).padStart(4)}  ${page}`)
const total = requirements.filter((r) => r.rfc2119).length
console.log(
  `${total} RFC 2119 statements, ${requirements.length - total} lowercase must or should statements, ${byPage.size} pages`,
)
