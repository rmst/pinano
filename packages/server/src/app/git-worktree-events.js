import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { isAbsolute, resolve, sep } from "node:path"

import { effectiveSandboxMounts, hostPathForMountedPath } from "./sandbox-paths.js"
import { addSessionWorkspaceRootMount } from "./tool-state-mounts.js"

export const GIT_WORKTREE_CUSTOM_TYPE = "git_worktree"
export const GIT_WORKTREE_ADD_OPERATION = "worktree.add"
export const GIT_WORKTREE_CLOSE_OPERATION = "worktree.close"
export const GIT_WORKTREE_REMOVE_OPERATION = "worktree.remove"
export const PINANO_WORKTREE_EVENT_ROUTE = "/internal/worktrees/events"
export const PINANO_INTEGRATION_TARGET_CONFIG = "pinano-integration-target"
export const PINANO_INITIAL_HEAD_CONFIG = "pinano-initial-head"
export const PINANO_CREATED_AT_CONFIG = "pinano-created-at"
export const GIT_WORKTREE_TERMINAL_APPLIED = "applied"
export const GIT_WORKTREE_TERMINAL_DISCARDED = "discarded"
export const GIT_WORKTREE_TERMINAL_DISCARDED_NO_WORK = "discarded_no_work"
export const GIT_WORKTREE_STATUS_CLEAN = "clean"
export const GIT_WORKTREE_STATUS_DIRTY = "dirty"
export const GIT_WORKTREE_STATUS_CONFLICTS = "conflicts"
export const GIT_WORKTREE_STATUS_REMOVED = "removed"

const DEFAULT_GIT_STATUS_TIMEOUT_MS = 2000
const DEFAULT_GIT_CLOSE_TIMEOUT_MS = 30000
const DEFAULT_GIT_WORKTREE_STATUS_LIMIT = 20
const PINANO_INTEGRATION_TARGET_COMPARISON_SOURCE = "pinano-integration-target"

function stringOrUndefined(value) {
	return typeof value === "string" && value ? value : undefined
}

function validTerminalState(value) {
	return value === GIT_WORKTREE_TERMINAL_APPLIED || value === GIT_WORKTREE_TERMINAL_DISCARDED || value === GIT_WORKTREE_TERMINAL_DISCARDED_NO_WORK
}

function publicTerminalState(value) {
	return value === GIT_WORKTREE_TERMINAL_DISCARDED_NO_WORK ? GIT_WORKTREE_TERMINAL_DISCARDED : value
}

function gitOutputDetail(result) {
	return `${result?.stderr ?? ""}${result?.stdout ?? ""}`.trim()
}

function normalizeOptionalMappedPath(workerPath, options = {}, label = "path") {
	const path = stringOrUndefined(workerPath)
	if (!path) return undefined
	if (!isAbsolute(path)) throw Object.assign(new Error(`worktree event ${label} must be absolute`), { status: 400 })
	return hostPathForWorkerGitWorktreePath(path, options.workerContext)
}

function sandboxMountPaths(sandbox) {
	return sandbox?.mountPaths ?? []
}

function sandboxUseSessionWd(sandbox) {
	return sandbox?.useSessionWd ?? true
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
		throw Object.assign(new Error("worktree event body must be an object"), { status: 400 })
	}
	if (payload.operation !== GIT_WORKTREE_ADD_OPERATION && payload.operation !== GIT_WORKTREE_CLOSE_OPERATION) throw Object.assign(new Error("unsupported worktree event operation"), { status: 400 })
	const workerPath = stringOrUndefined(payload.path)
	if (!workerPath || !isAbsolute(workerPath)) throw Object.assign(new Error("worktree event path must be absolute"), { status: 400 })
	const path = hostPathForWorkerGitWorktreePath(workerPath, options.workerContext)
	if (!path) return undefined
	const toolCallId = stringOrUndefined(payload.toolCallId)
	if (payload.operation === GIT_WORKTREE_CLOSE_OPERATION) {
		const terminalState = publicTerminalState(payload.terminalState)
		if (!validTerminalState(terminalState)) throw Object.assign(new Error("worktree close terminalState must be applied or discarded"), { status: 400 })
		return {
			version: 1,
			operation: GIT_WORKTREE_CLOSE_OPERATION,
			path,
			terminalState,
			...(toolCallId ? { toolCallId } : {}),
		}
	}
	const repositoryRoot = normalizeOptionalMappedPath(payload.repositoryRoot, options, "repositoryRoot")
	return {
		version: 1,
		operation: GIT_WORKTREE_ADD_OPERATION,
		path,
		...(stringOrUndefined(payload.branch) ? { branch: stringOrUndefined(payload.branch) } : {}),
		...(stringOrUndefined(payload.integrationTarget) ? { integrationTarget: stringOrUndefined(payload.integrationTarget) } : {}),
		...(stringOrUndefined(payload.initialHead) ? { initialHead: stringOrUndefined(payload.initialHead) } : {}),
		...(stringOrUndefined(payload.createdAt) ? { createdAt: stringOrUndefined(payload.createdAt) } : {}),
		...(repositoryRoot ? { repositoryRoot } : {}),
		...(toolCallId ? { toolCallId } : {}),
	}
}

function isStoredGitWorktreeAddEvent(data) {
	return data?.version === 1
		&& data.operation === GIT_WORKTREE_ADD_OPERATION
		&& typeof data.path === "string"
		&& isAbsolute(data.path)
}

function isStoredGitWorktreeTerminalEvent(data) {
	return data?.version === 1
		&& (data.operation === GIT_WORKTREE_CLOSE_OPERATION || data.operation === GIT_WORKTREE_REMOVE_OPERATION)
		&& typeof data.path === "string"
		&& isAbsolute(data.path)
		&& validTerminalState(data.terminalState)
}

function isStoredGitWorktreeEvent(data) {
	return isStoredGitWorktreeAddEvent(data) || isStoredGitWorktreeTerminalEvent(data)
}

function terminalWorktreeStatus(record) {
	const removedAt = stringOrUndefined(record.removedAt) ?? stringOrUndefined(record.closedAt)
	return {
		path: record.path,
		status: GIT_WORKTREE_STATUS_REMOVED,
		removed: true,
		terminalState: publicTerminalState(record.terminalState),
		...(record.branch ? { branch: record.branch } : {}),
		...(record.integrationTarget ? { integrationTarget: record.integrationTarget } : {}),
		...(record.repositoryRoot ? { repositoryRoot: record.repositoryRoot } : {}),
		...(record.comparison ? { comparison: record.comparison } : {}),
		...(typeof record.branchDeleted === "boolean" ? { branchDeleted: record.branchDeleted } : {}),
		...(record.cleanup ? { cleanup: record.cleanup } : {}),
		...(record.branchReset ? { branchReset: true } : {}),
		...(removedAt ? { removedAt } : {}),
		...(record.closedAt ? { closedAt: record.closedAt } : {}),
	}
}

function addRecordForEvent(data, path) {
	return {
		operation: GIT_WORKTREE_ADD_OPERATION,
		path,
		...(stringOrUndefined(data.branch) ? { branch: stringOrUndefined(data.branch) } : {}),
		...(stringOrUndefined(data.integrationTarget) ? { integrationTarget: stringOrUndefined(data.integrationTarget) } : {}),
		...(stringOrUndefined(data.initialHead) ? { initialHead: stringOrUndefined(data.initialHead) } : {}),
		...(stringOrUndefined(data.createdAt) ? { createdAt: stringOrUndefined(data.createdAt) } : {}),
		...(stringOrUndefined(data.repositoryRoot) ? { repositoryRoot: resolve(stringOrUndefined(data.repositoryRoot)) } : {}),
	}
}

export function gitWorktreeRecordsFromEntries(entries) {
	const byPath = new Map()
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (entry?.type !== "custom" || entry.customType !== GIT_WORKTREE_CUSTOM_TYPE) continue
		if (!isStoredGitWorktreeEvent(entry.data)) continue
		const path = resolve(entry.data.path)
		if (entry.data.operation === GIT_WORKTREE_ADD_OPERATION) {
			byPath.set(path, addRecordForEvent(entry.data, path))
			continue
		}
		byPath.set(path, {
			operation: entry.data.operation,
			path,
			terminalState: publicTerminalState(entry.data.terminalState),
			...(stringOrUndefined(entry.data.branch) ? { branch: stringOrUndefined(entry.data.branch) } : {}),
			...(stringOrUndefined(entry.data.integrationTarget) ? { integrationTarget: stringOrUndefined(entry.data.integrationTarget) } : {}),
			...(stringOrUndefined(entry.data.repositoryRoot) ? { repositoryRoot: resolve(stringOrUndefined(entry.data.repositoryRoot)) } : {}),
			...(stringOrUndefined(entry.data.head) ? { head: stringOrUndefined(entry.data.head) } : {}),
			...(entry.data.comparison ? { comparison: entry.data.comparison } : {}),
			...(typeof entry.data.branchDeleted === "boolean" ? { branchDeleted: entry.data.branchDeleted } : {}),
			...(entry.data.cleanup ? { cleanup: entry.data.cleanup } : {}),
			...(entry.data.branchReset === true ? { branchReset: true } : {}),
			...(stringOrUndefined(entry.data.closedAt) ? { closedAt: stringOrUndefined(entry.data.closedAt) } : {}),
			...(stringOrUndefined(entry.data.removedAt) ? { removedAt: stringOrUndefined(entry.data.removedAt) } : {}),
		})
	}
	return [...byPath.values()]
}

export function sessionGitWorktreeRecords(session) {
	return gitWorktreeRecordsFromEntries(typeof session?.getEntries === "function" ? session.getEntries() : [])
}

export function sessionOpenGitWorktreeRecords(session) {
	return sessionGitWorktreeRecords(session).filter((record) => record.operation === GIT_WORKTREE_ADD_OPERATION)
}

export async function resetInheritedSessionGitWorktrees(session, options = {}) {
	if (typeof session?.appendCustomEntry !== "function") return []
	const records = sessionOpenGitWorktreeRecords(session)
	const removedAt = options.removedAt ?? new Date().toISOString()
	const events = records.map((record) => ({
		version: 1,
		operation: GIT_WORKTREE_REMOVE_OPERATION,
		path: record.path,
		terminalState: GIT_WORKTREE_TERMINAL_DISCARDED,
		branchReset: true,
		removedAt,
		...(record.branch ? { branch: record.branch } : {}),
		...(record.integrationTarget ? { integrationTarget: record.integrationTarget } : {}),
		...(record.repositoryRoot ? { repositoryRoot: record.repositoryRoot } : {}),
	}))
	for (const event of events) await session.appendCustomEntry(GIT_WORKTREE_CUSTOM_TYPE, event)
	return events
}

export function sessionGitWorktreeCandidates(session) {
	return sessionOpenGitWorktreeRecords(session)
		.map((record) => ({ path: record.path }))
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

async function runGitOutput(args, options = {}) {
	let result
	try {
		result = await (options.runGit ?? runGit)(args, options)
	} catch {
		return undefined
	}
	if (result?.timedOut || result?.code !== 0) return undefined
	const output = String(result.stdout ?? "").trim()
	return output || undefined
}

async function runCloseGit(args, options = {}) {
	const closeOptions = {
		...options,
		timeoutMs: options.closeTimeoutMs ?? options.timeoutMs ?? DEFAULT_GIT_CLOSE_TIMEOUT_MS,
	}
	return await (options.runGit ?? runGit)(args, closeOptions)
}

function repositoryRootFromPinanoWorktreePath(path) {
	const normalized = resolve(path)
	const marker = `${sep}.pinano${sep}wt${sep}`
	const index = `${normalized}${sep}`.lastIndexOf(marker)
	return index > 0 ? normalized.slice(0, index) : undefined
}

async function gitCommonDirForWorktree(path, options = {}) {
	if (!existsSync(path)) return undefined
	return await runGitOutput(["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"], options)
}

async function gitDirForWorktree(path, options = {}) {
	if (!existsSync(path)) return undefined
	return await runGitOutput(["-C", path, "rev-parse", "--path-format=absolute", "--git-dir"], options)
}

export async function isLinkedGitWorktree(path, options = {}) {
	const [gitDir, gitCommonDir] = await Promise.all([
		gitDirForWorktree(path, options),
		gitCommonDirForWorktree(path, options),
	])
	if (!gitDir || !gitCommonDir) return false
	return resolve(gitDir) !== resolve(gitCommonDir)
}

async function gitCommandBaseForWorktree(record, options = {}) {
	const path = typeof record === "string" ? record : record.path
	const repositoryRoot = stringOrUndefined(record?.repositoryRoot) ?? repositoryRootFromPinanoWorktreePath(path)
	if (repositoryRoot) return { args: ["-C", repositoryRoot], repositoryRoot }
	const gitCommonDir = await gitCommonDirForWorktree(path, options)
	if (gitCommonDir) return { args: ["--git-dir", gitCommonDir], gitCommonDir }
	return { args: ["-C", path] }
}

function withGitBase(base, args) {
	return [...(base?.args ?? []), ...args]
}

function parseWorktreeListPaths(output) {
	return String(output ?? "")
		.split(/\r?\n/)
		.filter((line) => line.startsWith("worktree "))
		.map((line) => resolve(line.slice("worktree ".length).trim()))
}

async function worktreeRegistered(base, path, options = {}) {
	const result = await runCloseGit(withGitBase(base, ["worktree", "list", "--porcelain"]), options)
	if (result?.code !== 0) return undefined
	return parseWorktreeListPaths(result.stdout).includes(resolve(path))
}

async function removeLeftoverWorktreePath(path) {
	if (!existsSync(path)) return { pathRemoved: true }
	try {
		await rm(path, { recursive: true, force: true })
	} catch (err) {
		return { pathRemoved: !existsSync(path), leftoverRemovalError: err?.message ?? String(err) }
	}
	return { pathRemoved: !existsSync(path) }
}

async function removeWorktreePath(record, base, options = {}) {
	const path = typeof record === "string" ? record : record.path
	const beforeRegistered = await worktreeRegistered(base, path, options)
	const pathExistedBefore = existsSync(path)
	let removeResult = { code: 0, stdout: "", stderr: "" }
	let removeAttempted = false
	if (beforeRegistered !== false || pathExistedBefore) {
		removeAttempted = true
		removeResult = await runCloseGit(withGitBase(base, ["worktree", "remove", "--force", path]), options)
	}
	const afterRegistered = await worktreeRegistered(base, path, options)
	const pathExistsAfterGit = existsSync(path)
	const shouldRemoveLeftovers = afterRegistered === false && pathExistsAfterGit
	const leftover = shouldRemoveLeftovers ? await removeLeftoverWorktreePath(path) : { pathRemoved: !pathExistsAfterGit }
	const worktreeUnregistered = afterRegistered === false
	const worktreePathRemoved = leftover.pathRemoved === true
	const ok = worktreeUnregistered && worktreePathRemoved
	return {
		ok,
		worktreeUnregistered,
		worktreePathRemoved,
		pathExistedBefore,
		removeAttempted,
		...(beforeRegistered !== undefined ? { registeredBefore: beforeRegistered } : {}),
		...(afterRegistered !== undefined ? { registeredAfter: afterRegistered } : {}),
		...(removeAttempted ? { worktreeRemoveExitCode: removeResult?.code ?? 1 } : {}),
		...(removeAttempted && removeResult?.code !== 0 ? { worktreeRemoveError: gitOutputDetail(removeResult) || "git worktree remove failed" } : {}),
		...(leftover.leftoverRemovalError ? { leftoverRemovalError: leftover.leftoverRemovalError } : {}),
	}
}

function branchForClose(record, status) {
	return stringOrUndefined(record?.branch) ?? stringOrUndefined(status?.branch)
}

function branchDeleteSkipReason(branch, record, status) {
	if (!branch) return "branch unknown"
	const integrationTarget = stringOrUndefined(record?.integrationTarget) ?? stringOrUndefined(status?.comparison?.ref)
	if (integrationTarget && branch === integrationTarget) return "branch matches integration target"
	return undefined
}

async function localBranchExists(base, branch, options = {}) {
	const result = await runCloseGit(withGitBase(base, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]), options)
	if (result?.code === 0) return true
	if (result?.code === 1) return false
	return undefined
}

async function deleteWorktreeBranch(record, status, base, options = {}) {
	const branch = branchForClose(record, status)
	const skipReason = branchDeleteSkipReason(branch, record, status)
	if (skipReason) {
		return {
			branch,
			branchDeleted: undefined,
			branchDeleteSkipped: skipReason,
			ok: false,
		}
	}
	const existedBefore = await localBranchExists(base, branch, options)
	if (existedBefore === false) {
		return {
			branch,
			branchDeleted: true,
			branchAlreadyDeleted: true,
			ok: true,
		}
	}
	const result = await runCloseGit(withGitBase(base, ["branch", "-D", "--", branch]), options)
	const existsAfter = await localBranchExists(base, branch, options)
	const branchDeleted = result?.code === 0 || existsAfter === false
	return {
		branch,
		branchDeleted,
		...(existedBefore !== undefined ? { branchExistedBefore: existedBefore } : {}),
		...(existsAfter !== undefined ? { branchExistsAfter: existsAfter } : {}),
		branchDeleteExitCode: result?.code ?? 1,
		...(result?.code !== 0 && existsAfter !== false ? { branchDeleteError: gitOutputDetail(result) || "git branch delete failed" } : {}),
		ok: branchDeleted,
	}
}

function parseBranchAheadBehind(text) {
	const match = /^\+(\d+)\s+-(\d+)$/.exec(String(text ?? "").trim())
	if (!match) return undefined
	return {
		ahead: Number(match[1]),
		behind: Number(match[2]),
	}
}

function parseRevListAheadBehind(text) {
	const [behindText, aheadText] = String(text ?? "").trim().split(/\s+/)
	const ahead = Number(aheadText)
	const behind = Number(behindText)
	if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) return undefined
	return { ahead, behind }
}

function parseRevListRightOnlyCount(text) {
	const trimmed = String(text ?? "").trim()
	if (!/^\d+$/.test(trimmed)) return undefined
	const count = Number(trimmed)
	return Number.isSafeInteger(count) ? count : undefined
}

function comparisonFor(ref, counts, source, unapplied) {
	const label = stringOrUndefined(ref)
	if (!label || !counts) return undefined
	const { ahead, behind } = counts
	if (!Number.isSafeInteger(ahead) || ahead < 0 || !Number.isSafeInteger(behind) || behind < 0) return undefined
	return {
		ref: label,
		ahead,
		behind,
		source,
		...(Number.isSafeInteger(unapplied) && unapplied >= 0 ? { unapplied } : {}),
	}
}

function localBranchBase(branch) {
	const label = stringOrUndefined(branch)
	return label ? { label, rev: `refs/heads/${label}` } : undefined
}

async function revListComparison(path, base, source, options = {}) {
	const range = `${base.rev}...HEAD`
	const output = await runGitOutput(["-C", path, "rev-list", "--left-right", "--count", range], options)
	const unappliedOutput = await runGitOutput(["-C", path, "rev-list", "--right-only", "--cherry-pick", "--count", range], options)
	return comparisonFor(base.label, parseRevListAheadBehind(output), source, parseRevListRightOnlyCount(unappliedOutput))
}

async function firstWorkingComparison(path, bases, source, options = {}) {
	const seen = new Set()
	for (const base of bases.filter(Boolean)) {
		if (!base?.label || !base?.rev || seen.has(base.rev)) continue
		seen.add(base.rev)
		const comparison = await revListComparison(path, base, source, options)
		if (comparison) return comparison
	}
	return undefined
}

async function integrationTargetConfig(path, parsedStatus, options = {}) {
	const branch = stringOrUndefined(parsedStatus.branch)
	if (!branch) return undefined
	const target = await runGitOutput(["-C", path, "config", "--get", `branch.${branch}.${PINANO_INTEGRATION_TARGET_CONFIG}`], options)
	const base = localBranchBase(target)
	if (!base) return undefined
	const initialHead = stringOrUndefined(await runGitOutput(["-C", path, "config", "--get", `branch.${branch}.${PINANO_INITIAL_HEAD_CONFIG}`], options))
	return { base, initialHead }
}

function integrationTargetRecord(record) {
	const base = localBranchBase(record?.integrationTarget)
	if (!base) return undefined
	return { base, initialHead: stringOrUndefined(record.initialHead) }
}

async function changedSinceCreate(path, initialHead, options = {}) {
	const initial = stringOrUndefined(initialHead)
	if (!initial) return undefined
	const head = await runGitOutput(["-C", path, "rev-parse", "HEAD"], options)
	return stringOrUndefined(head) ? head !== initial : undefined
}

function publicWorktreeStatus(parsedStatus) {
	const { upstream, upstreamAhead, upstreamBehind, ...visible } = parsedStatus
	return visible
}

export function parseGitWorktreeStatus(output) {
	let head
	let oid
	let upstream
	let upstreamAhead
	let upstreamBehind
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
		if (line.startsWith("# branch.upstream ")) {
			upstream = line.slice("# branch.upstream ".length).trim()
			continue
		}
		if (line.startsWith("# branch.ab ")) {
			const counts = parseBranchAheadBehind(line.slice("# branch.ab ".length))
			if (counts) {
				upstreamAhead = counts.ahead
				upstreamBehind = counts.behind
			}
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
		...(upstream ? { upstream } : {}),
		...(Number.isSafeInteger(upstreamAhead) ? { upstreamAhead } : {}),
		...(Number.isSafeInteger(upstreamBehind) ? { upstreamBehind } : {}),
	}
}

async function gitWorktreePlainStatus(path, options = {}) {
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
	if (result?.timedOut) return undefined
	if (result?.code !== 0) return undefined
	return parseGitWorktreeStatus(result.stdout)
}

async function gitWorktreeStatusSnapshot(path, options = {}) {
	const parsedStatus = await gitWorktreePlainStatus(path, options)
	if (!parsedStatus) return undefined
	const integrationTarget = await integrationTargetConfig(path, parsedStatus, options) ?? integrationTargetRecord(options.record)
	if (!integrationTarget) return undefined
	const comparison = await firstWorkingComparison(path, [integrationTarget.base], PINANO_INTEGRATION_TARGET_COMPARISON_SOURCE, options)
	const hasWork = await changedSinceCreate(path, integrationTarget.initialHead, options) ?? (Number.isSafeInteger(comparison?.ahead) && comparison.ahead > 0)
	return {
		path,
		...publicWorktreeStatus(parsedStatus),
		...(comparison ? { comparison: { ...comparison, hasWork } } : {}),
	}
}

export async function gitWorktreeStatus(path, options = {}) {
	return await gitWorktreeStatusSnapshot(path, options)
}

function cleanupTerminalState(status) {
	if (status?.removed) return undefined
	if (status?.status !== GIT_WORKTREE_STATUS_CLEAN) return undefined
	const unapplied = Number(status.comparison?.unapplied)
	if (!Number.isSafeInteger(unapplied) || unapplied !== 0) return undefined
	return status.comparison?.hasWork === true ? GIT_WORKTREE_TERMINAL_APPLIED : GIT_WORKTREE_TERMINAL_DISCARDED
}

function closeEventIntegrationTarget(status, record) {
	return stringOrUndefined(status.comparison?.ref) ?? stringOrUndefined(record?.integrationTarget)
}

function closeEventForStatus(status, terminalState, options = {}) {
	const closedAt = stringOrUndefined(options.closedAt) ?? new Date().toISOString()
	const integrationTarget = closeEventIntegrationTarget(status, options.record)
	const branch = stringOrUndefined(options.branch) ?? stringOrUndefined(status.branch)
	const repositoryRoot = stringOrUndefined(options.repositoryRoot) ?? stringOrUndefined(options.record?.repositoryRoot)
	return {
		version: 1,
		operation: GIT_WORKTREE_CLOSE_OPERATION,
		path: resolve(status.path),
		terminalState: publicTerminalState(terminalState),
		closedAt,
		removedAt: closedAt,
		...(branch ? { branch } : {}),
		...(stringOrUndefined(options.head) ? { head: stringOrUndefined(options.head) } : {}),
		...(integrationTarget ? { integrationTarget } : {}),
		...(repositoryRoot ? { repositoryRoot } : {}),
		...(status.comparison ? { comparison: status.comparison } : {}),
		...(typeof options.branchDeleted === "boolean" ? { branchDeleted: options.branchDeleted } : {}),
		...(options.cleanup ? { cleanup: options.cleanup } : {}),
		...(stringOrUndefined(options.toolCallId) ? { toolCallId: stringOrUndefined(options.toolCallId) } : {}),
	}
}

async function worktreeHead(path, options = {}) {
	return await runGitOutput(["-C", path, "rev-parse", "HEAD"], options)
}

async function gitWorktreeStatusForClose(path, options = {}) {
	const status = await gitWorktreeStatusSnapshot(path, options)
	if (status) return status
	const parsedStatus = await gitWorktreePlainStatus(path, options)
	return parsedStatus ? { path, ...publicWorktreeStatus(parsedStatus) } : undefined
}

function fallbackCloseStatus(record) {
	return {
		path: record.path,
		...(stringOrUndefined(record.branch) ? { branch: stringOrUndefined(record.branch) } : {}),
		...(record.comparison ? { comparison: record.comparison } : {}),
	}
}

function cleanupOk(cleanup) {
	return cleanup?.worktree?.ok === true && cleanup?.branch?.ok !== false
}

function cleanupFailureMessage(cleanup) {
	const worktree = cleanup?.worktree
	const branch = cleanup?.branch
	if (worktree?.ok === false) {
		return worktree.leftoverRemovalError
			|| worktree.worktreeRemoveError
			|| "worktree could not be fully removed"
	}
	if (branch?.ok === false) {
		return branch.branchDeleteError
			|| (branch.branchDeleteSkipped ? `worktree branch was not deleted: ${branch.branchDeleteSkipped}` : undefined)
			|| "worktree branch could not be deleted"
	}
	return undefined
}

async function closeTrackedGitWorktree(record, terminalState, options = {}, preloadedStatus = undefined) {
	const path = typeof record === "string" ? record : record.path
	const status = preloadedStatus ?? await gitWorktreeStatusForClose(path, { ...options, record }) ?? fallbackCloseStatus(record)
	const head = status ? await worktreeHead(path, options) : stringOrUndefined(record.head)
	const base = await gitCommandBaseForWorktree(record, options)
	const repositoryRoot = stringOrUndefined(record.repositoryRoot) ?? stringOrUndefined(base.repositoryRoot)
	const worktree = await removeWorktreePath(record, base, options)
	if (!worktree.worktreeUnregistered) {
		const detail = worktree.worktreeRemoveError || "git worktree remove failed"
		throw Object.assign(new Error(detail), { status: 409, cleanup: { worktree } })
	}
	const branch = await deleteWorktreeBranch(record, status, base, options)
	const cleanup = {
		ok: worktree.ok && branch.ok !== false,
		worktree,
		branch,
	}
	const event = closeEventForStatus(status, terminalState, {
		head,
		record,
		branch: branch.branch,
		branchDeleted: branch.branchDeleted,
		repositoryRoot,
		cleanup,
		toolCallId: options.toolCallId,
	})
	return { status, terminalState, head, event, cleanup, cleanupOk: cleanupOk(cleanup), cleanupError: cleanupFailureMessage(cleanup) }
}

async function removeGitWorktree(record, options = {}, preloadedStatus = undefined) {
	const refreshed = preloadedStatus ?? await gitWorktreeStatus(record.path, { ...options, record })
	const terminalState = cleanupTerminalState(refreshed)
	if (!terminalState) return undefined
	return await closeTrackedGitWorktree(record, terminalState, options, refreshed)
}

export async function cleanupSessionGitWorktrees(session, options = {}) {
	if (typeof session?.appendCustomEntry !== "function") return []
	const records = sessionGitWorktreeRecords(session).filter((record) => record.operation === GIT_WORKTREE_ADD_OPERATION)
	const removed = []
	for (const record of records) {
		const status = await gitWorktreeStatus(record.path, { ...options, record })
		if (!cleanupTerminalState(status)) continue
		const removal = await removeGitWorktree(record, options, status)
		if (!removal) continue
		await session.appendCustomEntry(GIT_WORKTREE_CUSTOM_TYPE, removal.event)
		removed.push(removal.event)
	}
	return removed
}

export async function closeSessionGitWorktree(session, payload, options = {}) {
	if (typeof session?.appendCustomEntry !== "function") throw Object.assign(new Error("session cannot record worktree close events"), { status: 500 })
	const request = normalizeGitWorktreeEventPayload(payload, options)
	if (!request) return undefined
	if (request.operation !== GIT_WORKTREE_CLOSE_OPERATION) throw Object.assign(new Error("worktree close requires worktree.close operation"), { status: 400 })
	const record = sessionGitWorktreeRecords(session).find((candidate) => candidate.path === request.path)
	if (!record) throw Object.assign(new Error("worktree is not tracked as an open Pinano worktree in this session"), { status: 404 })
	if (record.operation !== GIT_WORKTREE_ADD_OPERATION) {
		if (record.terminalState !== request.terminalState) {
			throw Object.assign(new Error(`worktree is already closed as ${record.terminalState}`), { status: 409 })
		}
		return { event: record, entryId: undefined, status: terminalWorktreeStatus(record), alreadyClosed: true, cleanup: { ok: true, alreadyClosed: true }, cleanupOk: true }
	}
	const status = await gitWorktreeStatusForClose(record.path, { ...options, record })
	if (!status && request.terminalState === GIT_WORKTREE_TERMINAL_APPLIED && existsSync(record.path)) throw Object.assign(new Error("worktree status could not be read"), { status: 409 })
	if (status && request.terminalState === GIT_WORKTREE_TERMINAL_APPLIED && status.status !== GIT_WORKTREE_STATUS_CLEAN) {
		throw Object.assign(new Error("dirty worktree cannot be closed as applied; use --discarded to abandon it"), { status: 409 })
	}
	const close = await closeTrackedGitWorktree(record, request.terminalState, { ...options, toolCallId: request.toolCallId }, status)
	const entryId = await session.appendCustomEntry(GIT_WORKTREE_CUSTOM_TYPE, close.event)
	return { ...close, entryId }
}

export async function gitWorktreeStatusesFromRecords(records, options = {}) {
	const limit = options.limit ?? DEFAULT_GIT_WORKTREE_STATUS_LIMIT
	const statuses = []
	for (const record of records) {
		if (record.branchReset === true) continue
		const status = record.operation !== GIT_WORKTREE_ADD_OPERATION
			? terminalWorktreeStatus(record)
			: await gitWorktreeStatus(record.path, { ...options, record })
		if (!status) continue
		statuses.push(status)
		if (statuses.length >= limit) break
	}
	return statuses
}

export async function sessionGitWorktreeStatuses(session, options = {}) {
	return gitWorktreeStatusesFromRecords(sessionGitWorktreeRecords(session), options)
}
