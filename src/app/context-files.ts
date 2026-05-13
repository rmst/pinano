// Auto-discovery of project context files (AGENTS.md / CLAUDE.md).
//
// Ports pi's resource-loader.ts:loadProjectContextFiles. Pi searches a global
// agent dir plus every directory from the cwd up to the filesystem root, in
// the order: AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD (first hit per dir).
//
// pinano checks two global locations: `configRoot()` (i.e.
// `$PINANO_HOME/config/AGENTS.md` or `$XDG_CONFIG_HOME/pinano/AGENTS.md`) and
// the flat `~/.pinano/AGENTS.md`, mirroring pi's `~/.pi/agent/` convenience.

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { expandImports } from "./context-imports.ts"

export interface ContextFile {
	path: string
	content: string
}

const CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]

/**
 * Read the first AGENTS.md/CLAUDE.md found in `dir` (priority: AGENTS.md,
 * AGENTS.MD, CLAUDE.md, CLAUDE.MD). `@<path>` import lines are recursively
 * expanded — see `context-imports.ts`. Returns null if no candidate exists.
 *
 * Exported so the lazy loader can reuse exactly the same loading semantics
 * for subdir files.
 */
export function loadContextFileFromDir(dir: string): ContextFile | null {
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

export function loadProjectContextFiles(options: {
	cwd: string
	agentDirs: string[]
}): ContextFile[] {
	const out: ContextFile[] = []
	const seen = new Set<string>()

	for (const agentDir of options.agentDirs) {
		const global = loadContextFileFromDir(agentDir)
		if (global && !seen.has(global.path)) {
			out.push(global)
			seen.add(global.path)
		}
	}

	// Walk cwd → root, collecting one context file per dir, then reverse so
	// the root-most ancestor comes first (matches pi).
	const ancestors: ContextFile[] = []
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

