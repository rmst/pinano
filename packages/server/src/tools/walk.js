import { readdir, readFile, lstat, stat } from "node:fs/promises"
import { dirname, join, relative, sep } from "node:path"

import ignore from "./vendor/node-ignore/index.js"

const BINARY_SNIFF_BYTES = 8192

async function loadGitignore(dir) {
	try {
		return await readFile(join(dir, ".gitignore"), "utf-8")
	} catch {
		return null
	}
}

/** Expand a single level of `{a,b,c}` brace alternation into multiple patterns. */
export function expandBraces(pattern) {
	const m = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/)
	if (!m) return [pattern]
	const [, pre, mid, post] = m
	return mid.split(",").flatMap((opt) => expandBraces(pre + opt + post))
}

/** Build an ignore-style matcher from a glob (or array of globs). Supports `{a,b}` brace expansion. */
export function makeGlobMatcher(glob) {
	if (!glob) return null
	const patterns = Array.isArray(glob) ? glob.flatMap(expandBraces) : expandBraces(glob)
	const m = ignore()
	for (const p of patterns) m.add(p)
	return m
}

/** Heuristic: a file is binary if its first ~8KB contains a NUL byte (same rule rg uses by default). */
export function looksBinary(buffer) {
	const n = Math.min(buffer.length, BINARY_SNIFF_BYTES)
	for (let i = 0; i < n; i++) if (buffer[i] === 0) return true
	return false
}

/** Path of `to` relative to `from`, using forward slashes. */
function relPosix(from, to) {
	return relative(from, to).split(sep).join("/")
}

/**
 * Recursively walk `root` and yield `{ fullPath, relPath }` for every regular file
 * that isn't filtered out. Approximates ripgrep's default behavior: respects
 * nested `.gitignore` files (including ancestors up to the repo root), skips
 * `.git` directories, and skips dotfiles. If `glob` is set, only files matching
 * the glob are yielded.
 *
 * @param {string} root
 * @param {{ glob?: string, respectGitignore?: boolean, hidden?: boolean, signal?: AbortSignal }} [opts]
 */
export async function* walk(root, opts = {}) {
	const { glob, respectGitignore = true, hidden = false, signal } = opts
	const globMatcher = makeGlobMatcher(glob)
	const stack = respectGitignore ? await loadAncestorGitignores(root) : []
	yield* walkDir(root, root, stack, { globMatcher, respectGitignore, hidden, signal })
}

/**
 * Collect `.gitignore` files from ancestors of `root`, stopping after the directory
 * that contains `.git` (the repo root). Mirrors git's own discovery rules so that
 * searching a subdir of a repo still honors the root `.gitignore`.
 */
async function loadAncestorGitignores(root) {
	const stack = []
	let dir = dirname(root)
	while (dir !== dirname(dir)) {
		const content = await loadGitignore(dir)
		if (content) stack.unshift({ ig: ignore().add(content), dir })
		try {
			await stat(join(dir, ".git"))
			break
		} catch {}
		dir = dirname(dir)
	}
	return stack
}

async function* walkDir(root, dirPath, gitignoreStack, opts) {
	if (opts.signal?.aborted) return

	let stack = gitignoreStack
	if (opts.respectGitignore) {
		const content = await loadGitignore(dirPath)
		if (content) stack = [...stack, { ig: ignore().add(content), dir: dirPath }]
	}

	let entries
	try {
		entries = await readdir(dirPath)
	} catch {
		return
	}
	entries.sort()

	for (const name of entries) {
		if (opts.signal?.aborted) return
		if (name === ".git") continue
		if (!opts.hidden && name.startsWith(".")) continue

		const fullPath = join(dirPath, name)
		let st
		try {
			st = await lstat(fullPath)
		} catch {
			continue
		}

		if (st.isSymbolicLink()) continue
		const isDir = st.isDirectory()
		const isFile = st.isFile()
		if (!isDir && !isFile) continue

		if (isIgnoredByStack(stack, fullPath, isDir)) continue

		if (isDir) {
			yield* walkDir(root, fullPath, stack, opts)
		} else {
			const relPath = relPosix(root, fullPath)
			if (opts.globMatcher && !opts.globMatcher.ignores(relPath)) continue
			yield { fullPath, relPath }
		}
	}
}

function isIgnoredByStack(stack, childAbsPath, isDir) {
	for (const { ig, dir } of stack) {
		const rel = relPosix(dir, childAbsPath)
		if (!rel || rel.startsWith("../")) continue
		const check = isDir ? `${rel}/` : rel
		if (ig.ignores(check)) return true
	}
	return false
}
