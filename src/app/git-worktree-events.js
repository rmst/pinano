import { spawn } from "node:child_process"
import { isAbsolute, resolve } from "node:path"

import { effectiveSandboxMounts, hostPathForMountedPath } from "./sandbox-paths.js"
import { addSessionWorkspaceRootMount } from "./tool-state-mounts.js"

export const GIT_WORKTREE_CUSTOM_TYPE = "git_worktree"
export const GIT_WORKTREE_ADD_OPERATION = "worktree.add"
export const GIT_WORKTREE_STATUS_CLEAN = "clean"
export const GIT_WORKTREE_STATUS_DIRTY = "dirty"
export const GIT_WORKTREE_STATUS_CONFLICTS = "conflicts"
export const GIT_WORKTREE_STATUS_UNKNOWN = "unknown"

const DEFAULT_GIT_STATUS_TIMEOUT_MS = 2000
const DEFAULT_GIT_WORKTREE_STATUS_LIMIT = 20

const GLOBAL_FLAGS = new Set([
	"--bare",
	"--glob-pathspecs",
	"--icase-pathspecs",
	"--literal-pathspecs",
	"--no-literal-pathspecs",
	"--no-optional-locks",
	"--no-pager",
	"--no-replace-objects",
	"--noglob-pathspecs",
	"--paginate",
	"-p",
])

const ADD_FLAGS = new Set([
	"--checkout",
	"--detach",
	"--force",
	"--guess-remote",
	"--lock",
	"--no-checkout",
	"--no-relative-paths",
	"--no-track",
	"--quiet",
	"--relative-paths",
	"--track",
	"-f",
	"-q",
])

const ADD_VALUE_OPTIONS = new Set(["--orphan", "--reason"])

function stringOrUndefined(value) {
	return typeof value === "string" && value ? value : undefined
}

function optionName(arg) {
	const index = arg.indexOf("=")
	return index < 0 ? arg : arg.slice(0, index)
}

function hasInlineValue(arg) {
	return arg.includes("=")
}

function resolveAgainstCwd(path, cwd) {
	if (!path) return undefined
	if (isAbsolute(path)) return resolve(path)
	if (!cwd) return undefined
	return resolve(cwd, path)
}

function sandboxMountPaths(sandbox) {
	return sandbox?.mountPaths ?? sandbox?.paths ?? []
}

function sandboxUseSessionWd(sandbox) {
	return sandbox?.useSessionWd ?? true
}

function consumeGlobalOption(argv, index, cwd) {
	const arg = argv[index]
	if (arg === "-C") {
		const next = argv[index + 1]
		const resolved = resolveAgainstCwd(next, cwd)
		return resolved ? { index: index + 2, cwd: resolved } : undefined
	}
	if (arg.startsWith("-C") && arg.length > 2) {
		const resolved = resolveAgainstCwd(arg.slice(2), cwd)
		return resolved ? { index: index + 1, cwd: resolved } : undefined
	}
	if (arg === "-c") {
		if (index + 1 >= argv.length) return undefined
		return { index: index + 2, cwd }
	}
	if (arg.startsWith("-c") && arg.length > 2) return { index: index + 1, cwd }
	if (arg === "--config-env" || arg === "--namespace" || arg === "--super-prefix") {
		if (index + 1 >= argv.length) return undefined
		return { index: index + 2, cwd }
	}
	if (arg.startsWith("--config-env=") || arg.startsWith("--namespace=") || arg.startsWith("--super-prefix=")) return { index: index + 1, cwd }
	if (arg === "--git-dir" || arg === "--work-tree" || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) return undefined
	if (GLOBAL_FLAGS.has(arg)) return { index: index + 1, cwd }
	return undefined
}

function parseGitCommandPrefix(argv, cwd) {
	let index = 0
	let commandCwd = cwd
	while (index < argv.length) {
		const arg = argv[index]
		if (arg === "worktree") return { index, cwd: commandCwd }
		if (!arg.startsWith("-") || arg === "--") return undefined
		const consumed = consumeGlobalOption(argv, index, commandCwd)
		if (!consumed) return undefined
		index = consumed.index
		commandCwd = consumed.cwd
	}
	return undefined
}

function consumeWorktreeAddOption(argv, index) {
	const arg = argv[index]
	if (/^-f+$/.test(arg)) return index + 1
	if (arg === "-b" || arg === "-B") return index + 1 < argv.length ? index + 2 : undefined
	if ((arg.startsWith("-b") || arg.startsWith("-B")) && arg.length > 2) return index + 1
	if (ADD_FLAGS.has(arg)) return index + 1
	const name = optionName(arg)
	if (ADD_VALUE_OPTIONS.has(name)) return hasInlineValue(arg)
		? index + 1
		: index + 1 < argv.length ? index + 2 : undefined
	return undefined
}

function parseWorktreeAddPath(argv, commandIndex, cwd) {
	if (argv[commandIndex] !== "worktree" || argv[commandIndex + 1] !== "add") return undefined
	let index = commandIndex + 2
	let optionsEnded = false
	while (index < argv.length) {
		const arg = argv[index]
		if (!optionsEnded && arg === "--") {
			optionsEnded = true
			index++
			continue
		}
		if (!optionsEnded && arg.startsWith("-")) {
			const next = consumeWorktreeAddOption(argv, index)
			if (!next) return undefined
			index = next
			continue
		}
		return resolveAgainstCwd(arg, cwd)
	}
	return undefined
}

export function parseGitWorktreeAddPath(argv, options = {}) {
	if (!Array.isArray(argv)) return undefined
	const args = argv.map((arg) => String(arg))
	const cwd = stringOrUndefined(options.cwd)
	const prefix = parseGitCommandPrefix(args, cwd)
	if (!prefix) return undefined
	return parseWorktreeAddPath(args, prefix.index, prefix.cwd)
}

export function hostPathForWorkerGitWorktreePath(workerPath, workerContext = {}) {
	const path = stringOrUndefined(workerPath)
	if (!path || !isAbsolute(path)) return undefined
	if (workerContext.target?.type !== "local") return undefined
	const sandbox = workerContext.sandbox ?? { type: "none" }
	if (sandbox.type === "none") return resolve(path)
	if (sandbox.type !== "native" && sandbox.type !== "container") return undefined
	try {
		let mounts = effectiveSandboxMounts({
			sessionWd: workerContext.sessionWd ?? workerContext.startCwd,
			useSessionWd: sandboxUseSessionWd(sandbox),
			mountPaths: sandboxMountPaths(sandbox),
		}, "Git worktree path mapping")
		mounts = addSessionWorkspaceRootMount(mounts, stringOrUndefined(workerContext.sessionDir))
		return hostPathForMountedPath(mounts, path, { writableOnly: true })?.path
	} catch {
		return undefined
	}
}

export function normalizeGitWorktreeEventPayload(payload, options = {}) {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw Object.assign(new Error("git event body must be an object"), { status: 400 })
	}
	if (!Array.isArray(payload.argv)) throw Object.assign(new Error("git event argv must be an array"), { status: 400 })
	const workerPath = parseGitWorktreeAddPath(payload.argv, { cwd: stringOrUndefined(payload.cwd) })
	if (!workerPath) return undefined
	const path = hostPathForWorkerGitWorktreePath(workerPath, options.workerContext)
	if (!path) return undefined
	const toolCallId = stringOrUndefined(payload.toolCallId)
	return {
		version: 1,
		operation: GIT_WORKTREE_ADD_OPERATION,
		path,
		...(toolCallId ? { toolCallId } : {}),
	}
}

function isStoredGitWorktreeEvent(data) {
	return data?.version === 1
		&& data.operation === GIT_WORKTREE_ADD_OPERATION
		&& typeof data.path === "string"
		&& isAbsolute(data.path)
}

export function sessionGitWorktreeCandidates(session) {
	const entries = typeof session?.getEntries === "function" ? session.getEntries() : []
	const byPath = new Map()
	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== GIT_WORKTREE_CUSTOM_TYPE) continue
		if (!isStoredGitWorktreeEvent(entry.data)) continue
		const path = resolve(entry.data.path)
		byPath.set(path, { path })
	}
	return [...byPath.values()]
}

function runGit(args, options = {}) {
	const command = options.gitCommand ?? "git"
	const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_STATUS_TIMEOUT_MS
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
		let stdout = ""
		let stderr = ""
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeoutMs)
		child.stdout?.on("data", (chunk) => { stdout += chunk })
		child.stderr?.on("data", (chunk) => { stderr += chunk })
		child.on("error", (err) => {
			clearTimeout(timer)
			resolve({ code: 127, stdout, stderr: stderr || err?.message || String(err), timedOut })
		})
		child.on("exit", (code, signal) => {
			clearTimeout(timer)
			resolve({ code: code ?? (timedOut ? 124 : 1), signal, stdout, stderr, timedOut })
		})
	})
}

export function parseGitWorktreeStatus(output) {
	let head
	let oid
	let dirty = false
	let conflicts = false
	for (const line of String(output ?? "").split(/\r?\n/)) {
		if (!line) continue
		if (line.startsWith("# branch.head ")) {
			head = line.slice("# branch.head ".length).trim()
			continue
		}
		if (line.startsWith("# branch.oid ")) {
			oid = line.slice("# branch.oid ".length).trim()
			continue
		}
		if (line.startsWith("#")) continue
		dirty = true
		if (line.startsWith("u ")) conflicts = true
	}
	const detached = head === "(detached)" && oid && oid !== "(initial)"
		? oid.slice(0, 12)
		: undefined
	return {
		status: conflicts ? GIT_WORKTREE_STATUS_CONFLICTS : dirty ? GIT_WORKTREE_STATUS_DIRTY : GIT_WORKTREE_STATUS_CLEAN,
		...(head && head !== "(detached)" ? { branch: head } : {}),
		...(detached ? { detached } : {}),
	}
}

export async function gitWorktreeStatus(path, options = {}) {
	let result
	try {
		result = await (options.runGit ?? runGit)([
			"-C",
			path,
			"status",
			"--porcelain=v2",
			"--branch",
			"--untracked-files=normal",
		], options)
	} catch {
		return undefined
	}
	if (result?.timedOut) return { path, status: GIT_WORKTREE_STATUS_UNKNOWN }
	if (result?.code !== 0) return undefined
	return { path, ...parseGitWorktreeStatus(result.stdout) }
}

export async function sessionGitWorktreeStatuses(session, options = {}) {
	const candidates = sessionGitWorktreeCandidates(session)
	const limit = options.limit ?? DEFAULT_GIT_WORKTREE_STATUS_LIMIT
	const statuses = []
	for (const candidate of candidates) {
		const status = await gitWorktreeStatus(candidate.path, options)
		if (!status) continue
		statuses.push(status)
		if (statuses.length >= limit) break
	}
	return statuses
}
