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
const extrasFile = path.join(conformance, "requirements.extra.json")

const KEYWORD = /\b(MUST NOT|MUST|SHOULD NOT|SHOULD|MAY)\b/
const LOWERCASE = /\b(must not|must|should not|should)\b/
const FENCE = /^\s*(```|~~~)/
const HEADING = /^#{1,6}\s+(.*)$/
const ITEM = /^\s*([-*]|\d+\.)\s+/

const normalize = (text) => text.replace(/\s+/g, " ").replace(/\*\*/g, "").trim()

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
      const text = normalize(block.join(" "))
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
        if (FENCE.test(line)) {
          flush()
          closeLead()
          fenced = !fenced
          return
        }
        if (fenced) return
        const heading = line.match(HEADING)
        if (heading) {
          flush()
          closeLead()
          section = heading[1].trim()
          return
        }
        const item = ITEM.test(line)
        const row = /^\s*\|/.test(line)
        if (line.trim() === "" || item || row) flush()
        if (line.trim() === "") return
        if (!block.length) {
          blockLine = index + 1
          blockKind = item ? "item" : row ? "row" : "paragraph"
        }
        block.push(line.replace(ITEM, "").trim())
        if (row) flush()
      })
    flush()
    closeLead()
  }
  return requirements
}

const sections = (markdown) => {
  const found = [{ section: "", text: "", starts: [] }]
  let fenced = false
  markdown.split(/\r?\n/).forEach((line, index) => {
    if (FENCE.test(line)) fenced = !fenced
    const heading = !fenced && line.match(HEADING)
    if (heading) found.push({ section: heading[1].trim(), text: "", starts: [] })
    const part = normalize(line.replace(ITEM, ""))
    if (fenced || FENCE.test(line) || heading || part === "") return
    const current = found.at(-1)
    current.starts.push({ at: current.text.length, line: index + 1 })
    current.text += `${part} `
  })
  return found
}

// A quote is matched inside one section at a time, so it cannot be stitched together across a heading.
const locate = (markdown, quote) =>
  sections(markdown).flatMap(({ section, text, starts }) => {
    const at = text.indexOf(normalize(quote))
    return at === -1 ? [] : [{ section, line: starts.findLast((start) => start.at <= at).line }]
  })

const extras = JSON.parse(fs.readFileSync(extrasFile, "utf8"))
const curated = (extra, lineOf) => {
  const text = normalize([extra.lead, extra.text].filter(Boolean).join(" "))
  const id = requirementId(extra.page, extra.section, text)
  return {
    id,
    page: extra.page,
    line: lineOf(id),
    section: extra.section,
    level: extra.level,
    rfc2119: false,
    curated: true,
    text,
  }
}

const curationProblems = []
const curate = (specDir) =>
  extras.map((extra) => {
    const file = path.join(specDir, `${extra.page.replace(":", "/")}.md`)
    const markdown = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    const lines = [extra.lead, extra.text].filter(Boolean).map((quote) => {
      const hits = locate(markdown, quote)
      const hit = hits.find(({ section }) => section === extra.section)
      const entry = `requirements.extra.json entry for ${extra.page} "${quote}"`
      if (hits.length === 0) curationProblems.push(`${entry} is not on its page`)
      else if (hit === undefined) curationProblems.push(`${entry} is under section "${hits[0].section}"`)
      return hit?.line
    })
    return curated(extra, () => lines.at(-1))
  })

const fetchSpec = ({ repository, commit, path: versionPath }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spindle-spec-"))
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: ["ignore", "ignore", "inherit"] })
  try {
    git("init", "--quiet")
    git("fetch", "--quiet", "--depth", "1", repository, commit)
    git("checkout", "--quiet", "FETCH_HEAD")
    return [...extract(path.join(dir, versionPath)), ...curate(path.join(dir, versionPath))]
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const committed = fs.readFileSync(requirementsFile, "utf8")
const committedRequirements = JSON.parse(committed)
const committedLines = new Map(committedRequirements.filter((r) => r.curated).map((r) => [r.id, r.line]))
const requirements = refresh
  ? fetchSpec(JSON.parse(fs.readFileSync(lockFile, "utf8")))
  : [
      ...committedRequirements
        .filter((r) => !r.curated)
        .map((r) => ({ ...r, id: requirementId(r.page, r.section, r.text) })),
      ...extras.map((extra) => curated(extra, (id) => committedLines.get(id))),
    ]
if (curationProblems.length) {
  for (const problem of curationProblems) console.error(problem)
  process.exit(1)
}
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
  const row = byPage.get(r.page) ?? { rfc2119: 0, lowercase: 0, curated: 0 }
  row[r.curated ? "curated" : r.rfc2119 ? "rfc2119" : "lowercase"] += 1
  byPage.set(r.page, row)
}
if (!check)
  for (const [page, row] of byPage)
    console.log(
      `${String(row.rfc2119).padStart(4)} ${String(row.lowercase).padStart(4)} ${String(row.curated).padStart(4)}  ${page}`,
    )
const count = (kind) => [...byPage.values()].reduce((sum, row) => sum + row[kind], 0)
console.log(
  `${count("rfc2119")} RFC 2119 statements, ${count("lowercase")} lowercase must or should statements, ${count("curated")} curated statements with no keyword, ${byPage.size} pages`,
)
