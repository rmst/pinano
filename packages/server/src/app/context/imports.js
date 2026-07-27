// `@import` expansion for AGENTS.md / CLAUDE.md.
//
// `@<path>` references are replaced with the imported file's contents (with
// imports recursively expanded). Paths starting with `~/` are expanded against
// the user's home directory; relative paths resolve against the importing
// file's directory.
//
// Matches Claude Code's @import semantics — see
// https://code.claude.com/docs/en/memory.md — but pi/upstream does not have
// this; it's a deliberate divergence.
//
// The scanner is markdown-aware enough to skip inline code and fenced code
// blocks. Bare inline references must resolve to a real file, which keeps
// `@deprecated`, npm scopes, handles, and email-like strings from becoming
// noisy missing-import placeholders.

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"

const IMPORT_LINE = /^[ \t]*@(\S+)[ \t]*$/
const FENCE_LINE = /^[ \t]{0,3}(`{3,}|~{3,})/
const TRAILING_PUNCTUATION = ".,;:!?)]}>\"'"
export const MAX_IMPORT_DEPTH = 5

/**
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
	if (p === "~") return homedir()
	if (p.startsWith("~/")) return homedir() + p.slice(1)
	return p
}

/**
 * @param {string} rawPath
 * @param {string} fromDir
 * @returns {string}
 */
function resolveImportPath(rawPath, fromDir) {
	const raw = expandHome(rawPath)
	return isAbsolute(raw) ? raw : resolve(fromDir, raw)
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isFile(filePath) {
	try {
		return statSync(filePath).isFile()
	} catch {
		return false
	}
}

/**
 * @param {string} rawPath
 * @returns {boolean}
 */
function isExplicitImportPath(rawPath) {
	return rawPath === "~"
		|| rawPath.startsWith("./")
		|| rawPath.startsWith("../")
		|| rawPath.startsWith("/")
		|| rawPath.startsWith("~/")
}

/**
 * @param {string} token
 * @param {string} fromDir
 * @returns {{ rawPath: string, suffix: string, abs: string, exists: boolean }}
 */
function splitTrailingPunctuation(token, fromDir) {
	let rawPath = token
	let suffix = ""
	while (rawPath.length > 0) {
		const abs = resolveImportPath(rawPath, fromDir)
		if (isFile(abs)) return { rawPath, suffix, abs, exists: true }
		const last = rawPath.at(-1)
		if (!last || !TRAILING_PUNCTUATION.includes(last)) return { rawPath, suffix, abs, exists: false }
		rawPath = rawPath.slice(0, -1)
		suffix = last + suffix
	}
	return { rawPath, suffix, abs: resolveImportPath(rawPath, fromDir), exists: false }
}

/**
 * @param {string} rawPath
 * @param {string} abs
 * @param {number} depth
 * @param {Set<string>} visited
 * @param {(path: string) => boolean} [allowPath]
 * @returns {string}
 */
function expandResolvedImport(rawPath, abs, depth, visited, allowPath) {
	if (allowPath && !allowPath(abs)) return `<!-- cerex: blocked @import ${rawPath} -->`
	if (visited.has(abs)) return `<!-- cerex: skipped @import ${rawPath} (cycle) -->`
	if (!existsSync(abs)) return `<!-- cerex: missing @import ${rawPath} (${abs}) -->`
	try {
		const imported = readFileSync(abs, "utf-8")
		const nextVisited = new Set(visited)
		nextVisited.add(abs)
		return expandImports(imported, abs, depth + 1, nextVisited, allowPath)
	} catch {
		return `<!-- cerex: unreadable @import ${rawPath} -->`
	}
}

/**
 * @param {string} token
 * @param {string} fromDir
 * @param {number} depth
 * @param {Set<string>} visited
 * @param {boolean} required
 * @param {(path: string) => boolean} [allowPath]
 * @returns {string | null}
 */
function expandImportToken(token, fromDir, depth, visited, required, allowPath) {
	const { rawPath, suffix, abs, exists } = splitTrailingPunctuation(token, fromDir)
	if (!rawPath) return null
	if (!required && !exists && !isExplicitImportPath(rawPath)) return null
	return expandResolvedImport(rawPath, abs, depth, visited, allowPath) + suffix
}

/**
 * @param {string | undefined} ch
 * @returns {boolean}
 */
function isImportPrefix(ch) {
	return ch === undefined || /[\s([{"'<]/.test(ch)
}

/**
 * @param {string | undefined} ch
 * @returns {boolean}
 */
function isImportPathStart(ch) {
	return ch !== undefined && /[A-Za-z0-9_./~+-]/.test(ch)
}

/**
 * @param {string | undefined} ch
 * @returns {boolean}
 */
function isImportPathChar(ch) {
	return ch !== undefined && !/\s/.test(ch) && ch !== "<" && ch !== "`"
}

/**
 * @param {string} line
 * @param {number} start
 * @returns {number}
 */
function scanInlineCodeEnd(line, start) {
	let ticks = 1
	while (line[start + ticks] === "`") ticks++
	const closing = line.indexOf("`".repeat(ticks), start + ticks)
	return closing === -1 ? line.length : closing + ticks
}

/**
 * @param {string} line
 * @param {string} fromDir
 * @param {number} depth
 * @param {Set<string>} visited
 * @param {(path: string) => boolean} [allowPath]
 * @returns {string}
 */
function expandInlineImports(line, fromDir, depth, visited, allowPath) {
	let out = ""
	let i = 0
	while (i < line.length) {
		if (line[i] === "`") {
			const end = scanInlineCodeEnd(line, i)
			out += line.slice(i, end)
			i = end
			continue
		}
		if (line[i] === "@" && isImportPrefix(line[i - 1]) && isImportPathStart(line[i + 1])) {
			let end = i + 2
			while (isImportPathChar(line[end])) end++
			const token = line.slice(i + 1, end)
			const expanded = expandImportToken(token, fromDir, depth, visited, false, allowPath)
			if (expanded !== null) {
				out += expanded
				i = end
				continue
			}
		}
		out += line[i]
		i++
	}
	return out
}

/**
 * Expand `@<path>` imports in `content`. Imports are resolved relative to the
 * directory of `fromFile`. `visited` tracks paths in the current import chain
 * so a cycle terminates with a placeholder rather than infinite recursion.
 *
 * @param {string} content
 * @param {string} fromFile
 * @param {number} [depth]
 * @param {Set<string>} [visited]
 * @param {(path: string) => boolean} [allowPath]
 * @returns {string}
 */
export function expandImports(content, fromFile, depth = 0, visited = new Set(), allowPath = undefined) {
	if (depth > MAX_IMPORT_DEPTH) {
		return `${content}\n\n<!-- cerex: @import depth limit (${MAX_IMPORT_DEPTH}) reached -->`
	}
	const fromDir = dirname(fromFile)
	let inFence = false
	return content
		.split("\n")
		.map((line) => {
			if (FENCE_LINE.test(line)) {
				inFence = !inFence
				return line
			}
			if (inFence) return line
			const m = IMPORT_LINE.exec(line)
			if (m) return expandImportToken(m[1], fromDir, depth, visited, true, allowPath) ?? line
			return expandInlineImports(line, fromDir, depth, visited, allowPath)
		})
		.join("\n")
}
