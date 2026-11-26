#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const [specDir, outFile] = process.argv.slice(2);
if (!specDir) {
	console.error("Usage: node scripts/spec-requirements.mjs <spec-repo>/content/<version> [out.json]");
	process.exit(2);
}

const KEYWORD = /\b(MUST NOT|MUST|SHOULD NOT|SHOULD|MAY)\b/;
const LOWERCASE = /\b(must not|must|should not|should)\b/;

const walk = (dir) =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) return walk(full);
		return entry.name.endsWith(".md") ? [full] : [];
	});

const slug = (file) => path.relative(specDir, file).replace(/\.md$/, "").replace(/^(specification|infrastructure|distribution|getting-started)\//, "$1:");

const requirements = [];
for (const file of walk(specDir).sort()) {
	const page = slug(file);
	let section = "";
	let fenced = false;
	let block = [];
	let blockLine = 0;
	const flush = () => {
		if (!block.length) return;
		const text = block.join(" ").replace(/\s+/g, " ").replace(/\*\*/g, "").trim();
		block = [];
		const upper = text.match(KEYWORD);
		const lower = !upper && text.match(LOWERCASE);
		if (!upper && !lower) return;
		requirements.push({
			id: `${page}:${createHash("sha1").update(`${section}\n${text}`).digest("hex").slice(0, 8)}`,
			page,
			line: blockLine,
			section,
			level: (upper ? upper[1] : lower[1]).toUpperCase(),
			rfc2119: Boolean(upper),
			text,
		});
	};
	fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
		if (/^\s*(```|~~~)/.test(line)) {
			flush();
			fenced = !fenced;
			return;
		}
		if (fenced) return;
		const heading = line.match(/^#{1,6}\s+(.*)$/);
		if (heading) {
			flush();
			section = heading[1].trim();
			return;
		}
		const item = /^\s*([-*]|\d+\.)\s+/.test(line);
		const row = /^\s*\|/.test(line);
		if (line.trim() === "" || item || row) flush();
		if (line.trim() === "") return;
		if (!block.length) blockLine = index + 1;
		block.push(line.replace(/^\s*([-*]|\d+\.)\s+/, "").trim());
		if (row) flush();
	});
	flush();
}

if (outFile) fs.writeFileSync(outFile, `${JSON.stringify(requirements, null, "\t")}\n`);

const byPage = new Map();
for (const r of requirements) {
	const row = byPage.get(r.page) ?? { rfc2119: 0, lowercase: 0 };
	row[r.rfc2119 ? "rfc2119" : "lowercase"] += 1;
	byPage.set(r.page, row);
}
for (const [page, row] of byPage) console.log(`${String(row.rfc2119).padStart(4)} ${String(row.lowercase).padStart(4)}  ${page}`);
const total = requirements.filter((r) => r.rfc2119).length;
console.log(`${total} RFC 2119 statements, ${requirements.length - total} lowercase must or should statements, ${byPage.size} pages`);
