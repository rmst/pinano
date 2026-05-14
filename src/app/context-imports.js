// `@import` expansion for AGENTS.md / CLAUDE.md.
//
// A line whose only non-whitespace content is `@<path>` is replaced with the
// imported file's contents (with imports recursively expanded). Paths starting
// with `~/` are expanded against the user's home directory; relative paths
// resolve against the importing file's directory.
//
// Matches Claude Code's @import semantics — see
// https://code.claude.com/docs/en/memory.md — but pi/upstream does not have
// this; it's a deliberate divergence.
//
// We use line-based imports (rather than inline tokens) because inline `@foo`
// matching has too many false positives in prose (`@deprecated`, npm scopes
// like `@anthropic-ai/sdk`, email-like strings, etc.).

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"

const IMPORT_LINE = /^[ \t]*@(\S+)[ \t]*$/
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
 * Expand `@<path>` import lines in `content`. Imports are resolved relative to
 * the directory of `fromFile`. `visited` tracks paths in the current import
 * chain so a cycle terminates with a placeholder rather than infinite recursion.
 *
 * @param {string} content
 * @param {string} fromFile
 * @param {number} [depth]
 * @param {Set<string>} [visited]
 * @returns {string}
 */
export function expandImports(content, fromFile, depth = 0, visited = new Set()) {
	if (depth > MAX_IMPORT_DEPTH) {
		return `${content}\n\n<!-- pinano: @import depth limit (${MAX_IMPORT_DEPTH}) reached -->`
	}
	const fromDir = dirname(fromFile)
	return content
		.split("\n")
		.map((line) => {
			const m = IMPORT_LINE.exec(line)
			if (!m) return line
			const raw = expandHome(m[1])
			const abs = isAbsolute(raw) ? raw : resolve(fromDir, raw)
			if (visited.has(abs)) return `<!-- pinano: skipped @import ${m[1]} (cycle) -->`
			if (!existsSync(abs)) return `<!-- pinano: missing @import ${m[1]} (${abs}) -->`
			try {
				const imported = readFileSync(abs, "utf-8")
				const nextVisited = new Set(visited)
				nextVisited.add(abs)
				return expandImports(imported, abs, depth + 1, nextVisited)
			} catch {
				return `<!-- pinano: unreadable @import ${m[1]} -->`
			}
		})
		.join("\n")
}
