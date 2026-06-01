// Auto-discovery of project context files (AGENTS.md / CLAUDE.md).
//
// Ports pi's resource-loader.ts:loadProjectContextFiles. Pi searches a global
// agent dir plus every directory from the cwd up to the filesystem root, in
// the order: AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD (first hit per dir).
//
// pinano checks two global locations: `configRoot()` (i.e.
// `$PINANO_HOME/config/AGENTS.md`, defaulting to `~/.pinano/config/AGENTS.md`)
// and the flat `~/.pinano/AGENTS.md`, mirroring pi's `~/.pi/agent/` convenience.

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { expandImports } from "./context-imports.js"

/**
 * @typedef {object} ContextFile
 * @property {string} path
 * @property {string} content
 */

const CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]

/**
 * Read the first AGENTS.md/CLAUDE.md found in `dir` (priority: AGENTS.md,
 * AGENTS.MD, CLAUDE.md, CLAUDE.MD). `@<path>` imports are recursively
 * expanded — see `context-imports.ts`. Returns null if no candidate exists.
 *
 * Exported so the lazy loader can reuse exactly the same loading semantics
 * for subdir files.
 *
 * @param {string} dir
 * @returns {ContextFile | null}
 */
export function loadContextFileFromDir(dir) {
	for (const filename of CANDIDATES) {
		const filePath = join(dir, filename)
		if (existsSync(filePath)) {
			try {
				const raw = readFileSync(filePath, "utf-8")
				return { path: filePath, content: expandImports(raw, filePath) }
			} catch {
				// Unreadable file — skip silently; pi warns to stderr but pinano's
				// TUI swallows stderr, so a warning would be invisible anyway.
			}
		}
	}
	return null
}

/**
 * @param {{ cwd: string, agentDirs: string[] }} options
 * @returns {ContextFile[]}
 */
export function loadProjectContextFiles(options) {
	/** @type {ContextFile[]} */
	const out = []
	/** @type {Set<string>} */
	const seen = new Set()

	for (const agentDir of options.agentDirs) {
		const global = loadContextFileFromDir(agentDir)
		if (global && !seen.has(global.path)) {
			out.push(global)
			seen.add(global.path)
		}
	}

	// Walk cwd → root, collecting one context file per dir, then reverse so
	// the root-most ancestor comes first (matches pi).
	/** @type {ContextFile[]} */
	const ancestors = []
	let dir = options.cwd
	const root = resolve("/")
	while (true) {
		const file = loadContextFileFromDir(dir)
		if (file && !seen.has(file.path)) {
			ancestors.unshift(file)
			seen.add(file.path)
		}
		if (dir === root) break
		const parent = resolve(dir, "..")
		if (parent === dir) break
		dir = parent
	}

	out.push(...ancestors)
	return out
}
