// Lazy AGENTS.md/CLAUDE.md loading for paths under cwd.
//
// Startup loading (`context/files.js`) walks cwd → root, so ancestor files
// are captured at session start. Subdir files don't — they'd require knowing
// in advance which subdirs the agent will visit. Instead we load them
// on-demand: when a tool reads or mutates a concrete file under cwd, we walk
// from that path up to (but not past) cwd, picking up any context file we
// haven't yet seen. Directory discovery and broad searches do not load nested
// context. In normal sessions the file is stored as a context-load snapshot
// and injected through prompt assembly; no-session compatibility falls back to
// the legacy inline tool-result notice.
//
// This matches Claude Code's behavior
// (https://code.claude.com/docs/en/memory.md). Pi/upstream does not lazy-load.
//
// Resume semantics: context-load snapshots are replayed verbatim, so a
// resumed session never refreshes stale subdir content from disk. Legacy
// sessions that still have lazy context inside tool_result messages keep their
// previous conversation-history behavior; they are not migrated.

import { statSync } from "node:fs"
import { basename, isAbsolute, relative, resolve, dirname } from "node:path"

import { contextFileIdentity } from "../session-manager/context-identity.js"
import { loadContextFileFromDir } from "./context/files.js"
import { LAZY_NOTICE_HEADING, PROJECT_CONTEXT_HEADING } from "./context/format.js"
import { extractShellCommandPathInfo } from "./shell-paths.js"

/** @typedef {import("./context/files.js").ContextFile} ContextFile */

export { LAZY_NOTICE_HEADING }

/** Heading used by `project-context.ts` for the startup user message. We
 * recognise it here so that paths announced in that message also count as
 * "already loaded" and the lazy loader won't re-emit them. */
const STARTUP_CONTEXT_HEADING = PROJECT_CONTEXT_HEADING
const CONTEXT_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"])

export class LazyContextLoader {
	/** @type {string} */
	cwd
	/** @type {Set<string>} */
	loaded

	/** @param {{ cwd: string, alreadyLoaded: Iterable<string> }} options */
	constructor(options) {
		this.cwd = resolve(options.cwd)
		this.loaded = new Set()
		this.markLoaded(options.alreadyLoaded)
	}

	/** @param {string} cwd */
	setCwd(cwd) {
		this.cwd = resolve(cwd)
	}

	/** Paths already loaded (including those passed in at construction).
	 * @returns {ReadonlySet<string>}
	 */
	get loadedPaths() {
		return this.loaded
	}

	/** @param {Iterable<string>} paths */
	markLoaded(paths) {
		for (const path of paths) this.loaded.add(contextFileIdentity(path))
	}

	/**
	 * Add to the loaded-paths set every absolute path mentioned under one of
	 * our context-block headings in replayed history. We scan two slots:
	 *   - `toolResult` messages — where lazy notices live (LAZY_NOTICE_HEADING).
	 *   - structurally marked `user` project-context messages — where the startup project-context block lives (STARTUP_CONTEXT_HEADING).
	 *
	 * Idempotent: safe to call before every `loadForPath`, including after a
	 * mid-session resume that swapped in different history.
	 *
	 * Path lines are matched as absolute-path markdown headings — we always
	 * emit absolute paths in the notice, so this is unambiguous in practice. (False positives
	 * would require an actual AGENTS.md file to contain a literal `## /...`
	 * line at column 0, which is exotic enough to ignore.)
	 *
	 * @param {ReadonlyArray<any>} messages
	 */
	hydrateFromMessages(messages) {
		for (const m of messages) {
			const role = m?.role
			const heading = role === "toolResult" ? LAZY_NOTICE_HEADING
				: role === "user" && m.projectContext === true ? STARTUP_CONTEXT_HEADING
				: null
			if (!heading) continue
			const content = m.content
			if (!Array.isArray(content)) continue
			for (const block of content) {
				if (block?.type !== "text" || typeof block.text !== "string") continue
				const idx = block.text.indexOf(heading)
				if (idx === -1) continue
				const after = block.text.slice(idx)
				const re = /^##\s+(\/.+?)\s*$/gm
				/** @type {RegExpExecArray | null} */
				let match
				while ((match = re.exec(after))) {
					this.markLoaded([match[1]])
				}
			}
		}
	}

	/**
	 * For a tool-read or tool-mutated file path, walk from `path` up to cwd
	 * looking for unseen AGENTS.md/CLAUDE.md files. Returns newly-loaded files
	 * in root-most-first order (matching the startup ancestor walk). Updates
	 * internal state so a subsequent call won't return the same file again.
	 *
	 * Paths outside the cwd subtree are ignored — those would either already be
	 * loaded by startup ancestor walk (if above cwd) or out of scope (siblings).
	 *
	 * @param {string} path
	 * @returns {ContextFile[]}
	 */
	loadForPath(path) {
		const abs = isAbsolute(path) ? path : resolve(this.cwd, path)
		const rel = relative(this.cwd, abs)
		// Empty rel → path === cwd (already loaded). ".." prefix or absolute rel
		// → outside cwd subtree.
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return []

		// Walk from `abs` itself up to (but not including) cwd. If `abs` is a
		// regular file, the `<file>/AGENTS.md` lookup just returns null before
		// the walk reaches its containing directories. This also keeps write-new-file
		// triggers useful without needing the file to exist before the mutation.
		/** @type {string[]} */
		const dirs = []
		let dir = abs
		while (resolve(dir) !== this.cwd) {
			dirs.unshift(dir)
			const parent = dirname(dir)
			if (parent === dir) break
			dir = parent
		}

		/** @type {ContextFile[]} */
		const out = []
		for (const d of dirs) {
			const file = loadContextFileFromDir(d)
			const key = file ? contextFileIdentity(file) : ""
			if (file && !this.loaded.has(key)) {
				this.loaded.add(key)
				out.push(file)
			}
		}
		return out
	}
}

/**
 * Format newly-loaded context files as a notice to append to a tool result.
 * Heading is distinct from the startup `# Project Context` block so the model
 * can tell this is incremental.
 *
 * @param {ContextFile[]} files
 * @returns {string}
 */
export function formatLazyContextNotice(files) {
	if (files.length === 0) return ""
	let out = "\n\n---\n\n# Additional project context (loaded on demand)\n\n"
	for (const { path, content } of files) {
		out += `## ${path}\n\n${content}\n\n`
	}
	return out
}

const DIRECT_FILE_TOOLS = new Set(["read", "write", "edit", "grep", "view_image"])

function isContextFilePath(path) {
	return CONTEXT_FILE_NAMES.has(basename(path))
}

function resolvePathForCwd(path, cwd) {
	return isAbsolute(path) ? path : resolve(cwd, path)
}

function isRegularFile(path) {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}

function extractExecCommandPaths(args, cwd) {
	const command = typeof args?.cmd === "string" ? args.cmd : ""
	const baseCwd = typeof args?.workdir === "string"
		? (isAbsolute(args.workdir) ? args.workdir : resolve(cwd, args.workdir))
		: cwd
	/** @type {string[]} */
	const paths = []
	/** @type {string[]} */
	const manuallyLoadedContextPaths = []
	const extracted = extractShellCommandPathInfo(command, baseCwd)
	paths.push(...extracted.paths)
	manuallyLoadedContextPaths.push(...extracted.manuallyLoadedContextPaths)
	return { paths, manuallyLoadedContextPaths }
}

function readManuallyLoadedContextPaths(args, cwd, result) {
	if (typeof args?.path !== "string") return []
	const abs = resolvePathForCwd(args.path, cwd)
	if (!isContextFilePath(abs)) return []
	return result?.details?.text?.fullFile === true ? [abs] : []
}

/**
 * Pick file paths from a tool call that read or mutated concrete files. Directory listing and broad search tools intentionally return nothing; they reveal structure, not an adjacent file whose scoped instructions should enter context.
 *
 * @param {string} toolName
 * @param {any} args
 * @param {string} cwd
 * @param {any} [result]
 * @returns {{ paths: string[], manuallyLoadedContextPaths: string[] }}
 */
export function extractToolPaths(toolName, args, cwd = process.cwd(), result = undefined) {
	if (toolName === "apply_patch") {
		if (typeof args !== "string") return { paths: [], manuallyLoadedContextPaths: [] }
		const paths = [...args.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1])
		return { paths, manuallyLoadedContextPaths: [] }
	}
	if (toolName === "exec_command") return extractExecCommandPaths(args, cwd)
	if (!DIRECT_FILE_TOOLS.has(toolName)) return { paths: [], manuallyLoadedContextPaths: [] }
	if (toolName === "read" && args && typeof args.path === "string") {
		return { paths: [args.path], manuallyLoadedContextPaths: readManuallyLoadedContextPaths(args, cwd, result) }
	}
	if (toolName === "grep" && args && typeof args.path === "string") {
		return { paths: isRegularFile(resolvePathForCwd(args.path, cwd)) ? [args.path] : [], manuallyLoadedContextPaths: [] }
	}
	if (args && typeof args.path === "string") return { paths: [args.path], manuallyLoadedContextPaths: [] }
	return { paths: [], manuallyLoadedContextPaths: [] }
}

/** Pick the path arg from a tool call, or null if the tool isn't path-bound.
 * @param {string} toolName
 * @param {any} args
 * @param {string} [cwd]
 * @returns {string | null}
 */
export function extractToolPath(toolName, args, cwd = process.cwd()) {
	return extractToolPaths(toolName, args, cwd).paths[0] ?? null
}
