import { spawn } from "node:child_process"
import { readFile, stat } from "node:fs/promises"

import { resolveToCwd } from "./path-utils.js"
import { GREP_MAX_LINE_LENGTH, truncateLine } from "./truncate.js"
import { looksBinary, walk } from "./walk.js"

const DEFAULT_LIMIT = 100

const grepSchema = {
	type: "object",
	properties: {
		pattern: { type: "string", description: "Search pattern (regex by default, see `literal`)" },
		path: { type: "string", description: "Directory or file to search (default: cwd)" },
		glob: { type: "string", description: "Filter files by glob, e.g. '*.ts' or '**/*.spec.ts'" },
		ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
		literal: { type: "boolean", description: "Treat pattern as literal string (default: false)" },
		context: { type: "number", description: "Lines of context before and after each match (default: 0)" },
		limit: { type: "number", description: `Max matches to return (default: ${DEFAULT_LIMIT})` },
	},
	required: ["pattern"],
	additionalProperties: false,
}

let rgProbe

/** Probe once whether `rg` is in PATH. Cached for the process lifetime. */
function probeRg() {
	if (rgProbe) return rgProbe
	rgProbe = new Promise((resolve) => {
		let child
		try {
			child = spawn("rg", ["--version"])
		} catch {
			resolve(false)
			return
		}
		let done = false
		const finish = (v) => {
			if (done) return
			done = true
			resolve(v)
		}
		child.on("error", () => finish(false))
		child.on("close", (code) => finish(code === 0))
	})
	return rgProbe
}

/** Test-only: force the probe result. Pass `undefined` to clear the cache. */
export function _setRgAvailable(value) {
	rgProbe = value === undefined ? undefined : Promise.resolve(value)
}

/**
 * Search file contents. Uses ripgrep when available, falls back to a pure-JS
 * walker (respects .gitignore, skips binaries) when `rg` is missing. Both paths
 * produce the same output shape.
 *
 * @param {string} cwd
 * @returns {import("../agent-core/types.js").AgentTool}
 */
export function createGrepTool(cwd) {
	return {
		name: "grep",
		label: "grep",
		description:
			"Search file contents (ripgrep when available, pure-JS fallback otherwise). Returns up to `limit` matches with optional context lines. Files matching .gitignore are skipped by default.",
		parameters: grepSchema,
		async execute(_id, args, signal) {
			const limit = args.limit ?? DEFAULT_LIMIT
			const target = args.path ? resolveToCwd(args.path, cwd) : cwd
			const opts = {
				pattern: args.pattern,
				target,
				cwd,
				glob: args.glob,
				ignoreCase: args.ignoreCase === true,
				literal: args.literal === true,
				context: args.context ?? 0,
				limit,
				signal,
			}
			const haveRg = await probeRg()
			const { lines, matches, limitReached, linesTruncated } = haveRg ? await runRg(opts) : await runJs(opts)
			const text = matches === 0 ? "(no matches)" : lines.join("\n")
			const trailers = []
			if (limitReached) trailers.push(`[Match limit reached: showing first ${limit} matches]`)
			if (linesTruncated) trailers.push(`[Some long lines truncated to ${GREP_MAX_LINE_LENGTH} chars]`)
			const out = trailers.length > 0 ? `${text}\n${trailers.join("\n")}` : text
			return {
				content: [{ type: "text", text: out }],
				details: { matchCount: matches, limitReached, linesTruncated },
			}
		},
	}
}

function runRg({ pattern, target, cwd, glob, ignoreCase, literal, context, limit, signal }) {
	const rgArgs = ["--json", "-n", "--no-heading"]
	if (ignoreCase) rgArgs.push("-i")
	if (literal) rgArgs.push("-F")
	if (context) rgArgs.push("-C", String(context))
	if (glob) rgArgs.push("-g", glob)
	rgArgs.push("-e", pattern, target)

	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Operation aborted"))
			return
		}
		const child = spawn("rg", rgArgs, { cwd })
		if (!child.stdout || !child.stderr) {
			reject(new Error("ripgrep: failed to attach to child process streams"))
			return
		}
		let stdout = ""
		let stderr = ""
		let aborted = false
		const onAbort = () => {
			aborted = true
			child.kill("SIGTERM")
		}
		signal?.addEventListener("abort", onAbort, { once: true })
		child.stdout.on("data", (c) => {
			stdout += c.toString("utf-8")
		})
		child.stderr.on("data", (c) => {
			stderr += c.toString("utf-8")
		})
		child.on("error", (err) => {
			signal?.removeEventListener("abort", onAbort)
			reject(err)
		})
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort)
			if (aborted) {
				reject(new Error("Operation aborted"))
				return
			}
			if (code === 2) {
				reject(new Error(stderr.trim() || "ripgrep failed"))
				return
			}
			resolve(parseRgJson(stdout, limit))
		})
	})
}

function parseRgJson(stdout, limit) {
	const lines = []
	let matches = 0
	let limitReached = false
	let linesTruncated = false
	for (const raw of stdout.split("\n")) {
		if (!raw) continue
		let evt
		try {
			evt = JSON.parse(raw)
		} catch {
			continue
		}
		if (evt.type === "match") {
			matches++
			if (matches > limit) {
				limitReached = true
				continue
			}
			const file = evt.data.path?.text ?? ""
			const lineNumber = evt.data.line_number ?? 0
			const lineText = evt.data.lines?.text ?? ""
			const stripped = lineText.endsWith("\n") ? lineText.slice(0, -1) : lineText
			const trunc = truncateLine(stripped)
			if (trunc.wasTruncated) linesTruncated = true
			lines.push(`${file}:${lineNumber}: ${trunc.text}`)
		} else if (evt.type === "context" && matches <= limit) {
			const file = evt.data.path?.text ?? ""
			const lineNumber = evt.data.line_number ?? 0
			const lineText = evt.data.lines?.text ?? ""
			const stripped = lineText.endsWith("\n") ? lineText.slice(0, -1) : lineText
			const trunc = truncateLine(stripped)
			if (trunc.wasTruncated) linesTruncated = true
			lines.push(`${file}:${lineNumber}- ${trunc.text}`)
		}
	}
	return { lines, matches: Math.min(matches, limit), limitReached, linesTruncated }
}

function escapeRegex(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Translate common rg/PCRE patterns into JS RegExp syntax:
 *   - leading inline flags `(?i)`, `(?im)`, `(?s)foo` → JS flags + stripped prefix
 *   - Python-style named groups `(?P<name>...)` → JS `(?<name>...)`
 *   - Python-style backrefs `(?P=name)` → JS `\k<name>`
 *
 * Returns `{ source, extraFlags }`. Conservative — only touches well-known
 * forms, leaves anything else untouched so an authentic JS regex still works.
 */
function translatePcreToJs(pattern) {
	let source = pattern
	let extraFlags = ""
	const flagMatch = source.match(/^\(\?([imsx]+)\)/)
	if (flagMatch) {
		for (const f of flagMatch[1]) {
			if (f === "i" || f === "m" || f === "s") {
				if (!extraFlags.includes(f)) extraFlags += f
			}
		}
		source = source.slice(flagMatch[0].length)
	}
	source = source.replace(/\(\?P<([^>]+)>/g, "(?<$1>").replace(/\(\?P=([^)]+)\)/g, "\\k<$1>")
	return { source, extraFlags }
}

function buildRegex(pattern, { literal, ignoreCase }) {
	if (literal) return new RegExp(escapeRegex(pattern), ignoreCase ? "i" : "")
	const { source, extraFlags } = translatePcreToJs(pattern)
	let flags = ignoreCase ? "i" : ""
	for (const f of extraFlags) if (!flags.includes(f)) flags += f
	return new RegExp(source, flags)
}

async function runJs({ pattern, target, glob, ignoreCase, literal, context, limit, signal }) {
	let re
	try {
		re = buildRegex(pattern, { literal, ignoreCase })
	} catch (err) {
		throw new Error(`invalid regex pattern: ${err.message}`)
	}

	const out = []
	let matches = 0
	let limitReached = false
	let linesTruncated = false

	const processFile = async (fullPath) => {
		if (signal?.aborted) throw new Error("Operation aborted")
		const res = await scanFile(fullPath, re, context, limit, matches)
		for (const line of res.lines) out.push(line)
		matches += res.matchCount
		if (res.limitReached) limitReached = true
		if (res.linesTruncated) linesTruncated = true
	}

	const targetStat = await stat(target).catch(() => null)
	if (targetStat?.isFile()) {
		await processFile(target)
	} else if (targetStat?.isDirectory()) {
		for await (const { fullPath } of walk(target, { glob, signal })) {
			await processFile(fullPath)
		}
	}

	return { lines: out, matches: Math.min(matches, limit), limitReached, linesTruncated }
}

async function scanFile(fullPath, re, context, limit, alreadyMatched) {
	let buf
	try {
		buf = await readFile(fullPath)
	} catch {
		return { lines: [], matchCount: 0, limitReached: false, linesTruncated: false }
	}
	if (looksBinary(buf)) return { lines: [], matchCount: 0, limitReached: false, linesTruncated: false }

	const text = buf.toString("utf-8")
	const allLines = text.split("\n")
	if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop()

	const matchLineIdxs = []
	for (let i = 0; i < allLines.length; i++) {
		re.lastIndex = 0
		if (re.test(allLines[i])) matchLineIdxs.push(i)
	}
	if (matchLineIdxs.length === 0) {
		return { lines: [], matchCount: 0, limitReached: false, linesTruncated: false }
	}

	const ranges = []
	for (const idx of matchLineIdxs) {
		const s = Math.max(0, idx - context)
		const e = Math.min(allLines.length - 1, idx + context)
		if (ranges.length > 0 && ranges[ranges.length - 1][1] >= s - 1) {
			ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], e)
		} else {
			ranges.push([s, e])
		}
	}

	const matchSet = new Set(matchLineIdxs)
	const lines = []
	let linesTruncated = false
	let matchCount = 0
	let limitReached = false

	for (const [s, e] of ranges) {
		for (let i = s; i <= e; i++) {
			const isMatch = matchSet.has(i)
			if (isMatch) {
				matchCount++
				if (alreadyMatched + matchCount > limit) {
					limitReached = true
					continue
				}
			} else if (alreadyMatched + matchCount >= limit) {
				continue
			}
			const sep = isMatch ? ":" : "-"
			const trunc = truncateLine(allLines[i])
			if (trunc.wasTruncated) linesTruncated = true
			lines.push(`${fullPath}:${i + 1}${sep} ${trunc.text}`)
		}
	}

	return { lines, matchCount, limitReached, linesTruncated }
}
