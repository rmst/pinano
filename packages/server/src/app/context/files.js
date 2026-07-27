// Auto-discovery of project context files (AGENTS.md / CLAUDE.md).
//
// Ports pi's resource-loader.ts:loadProjectContextFiles. Pi searches a global
// agent dir plus every directory from the cwd up to the filesystem root, in
// the order: AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD (first hit per dir).
//
// Cerex checks configured global agent dirs before project ancestors. The
// default global dir is `$CEREX_HOME` (`~/.cerex` by default).

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { contextFileIdentity, contextFileIdentityPath } from "../../session-manager/context-identity.js"
import { expandImports } from "./imports.js"

/**
 * @typedef {object} ContextFile
 * @property {string} path
 * @property {string} identityPath
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
 * @param {{ allowPath?: (path: string) => boolean }} [options]
 * @returns {ContextFile | null}
 */
export function loadContextFileFromDir(dir, options = {}) {
	for (const filename of CANDIDATES) {
		const filePath = join(dir, filename)
		if (existsSync(filePath)) {
			try {
				const identityPath = contextFileIdentityPath(filePath)
				const allowPath = (path) => options.allowPath?.(contextFileIdentityPath(path)) !== false
				if (!allowPath(identityPath)) continue
				const raw = readFileSync(filePath, "utf-8")
				return { path: filePath, identityPath, content: expandImports(raw, filePath, 0, new Set(), allowPath) }
			} catch {
				// Unreadable file — skip silently; pi warns to stderr but Cerex's
				// TUI swallows stderr, so a warning would be invisible anyway.
			}
		}
	}
	return null
}

/**
 * @param {string[]} agentDirs
 * @param {{ allowPath?: (path: string) => boolean }} [options]
 * @returns {ContextFile[]}
 */
export function loadGlobalContextFiles(agentDirs, options = {}) {
	/** @type {ContextFile[]} */
	const out = []
	/** @type {Set<string>} */
	const seen = new Set()

	for (const agentDir of agentDirs) {
		const global = loadContextFileFromDir(agentDir, options)
		const key = global ? contextFileIdentity(global) : ""
		if (global && !seen.has(key)) {
			out.push(global)
			seen.add(key)
		}
	}
	return out
}

/**
 * @param {{ cwd: string, agentDirs?: string[], root?: string, allowPath?: (path: string) => boolean }} options
 * @returns {ContextFile[]}
 */
export function loadProjectContextFiles(options) {
	const out = loadGlobalContextFiles(options.agentDirs ?? [], options)
	const seen = new Set(out.map(contextFileIdentity))
	const cwd = resolve(options.cwd)
	const root = resolve(options.root ?? "/")
	const rel = relative(root, cwd)
	if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Project context cwd is outside its root: ${cwd}`)

	// Walk cwd → root, collecting one context file per dir, then reverse so
	// the root-most ancestor comes first (matches pi).
	/** @type {ContextFile[]} */
	const ancestors = []
	let dir = cwd
	while (true) {
		const file = loadContextFileFromDir(dir, options)
		const key = file ? contextFileIdentity(file) : ""
		if (file && !seen.has(key)) {
			ancestors.unshift(file)
			seen.add(key)
		}
		if (dir === root) break
		const parent = resolve(dir, "..")
		if (parent === dir) break
		dir = parent
	}

	out.push(...ancestors)
	return out
}

/**
 * Load context files scoped between a concrete project path and its project cwd. Unlike startup loading, this excludes the cwd itself because it was already captured when the session started.
 * @param {{ cwd: string, path: string, requireFile?: boolean, allowPath?: (path: string) => boolean }} options
 * @returns {ContextFile[]}
 */
export function loadContextFilesForPath({ cwd, path, requireFile = false, allowPath }) {
	const root = resolve(cwd)
	const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path)
	const rel = relative(root, absolutePath)
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return []
	if (requireFile) {
		try {
			if (!statSync(absolutePath).isFile()) return []
		} catch {
			return []
		}
	}
	const dirs = []
	let dir = absolutePath
	while (resolve(dir) !== root) {
		dirs.unshift(dir)
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return dirs.map((dir) => loadContextFileFromDir(dir, { allowPath })).filter(Boolean)
}
