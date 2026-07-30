import { execFile } from "node:child_process"
import { lstat, readFile, readlink, realpath, rm, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"
import {
	INITIAL_HEAD_CONFIG,
	INTEGRATION_TARGET_CONFIG,
	LEGACY_INITIAL_HEAD_CONFIG,
	LEGACY_INTEGRATION_TARGET_CONFIG,
} from "./worktree-events.js"

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 10_000
const GIT_REMOTE_TIMEOUT_MS = 120_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const DEFAULT_COMMIT_LIMIT = 80
const MAX_COMMIT_LIMIT = 200
const MIN_COMMIT_HASH_LENGTH = 4
const MISSING_FILE_STAT_CODES = new Set(["ENOENT", "ENOTDIR"])
const MAX_CHANGE_TEXT_BYTES = 2 * 1024 * 1024
const MAX_COMMIT_MESSAGE_BYTES = 256 * 1024
const CONFLICT_STATUSES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"])
const COMMIT_ACTIONS = new Set(["commit", "amend", "commit-and-push", "commit-and-sync"])

const git = async (args, cwd, { timeout = GIT_TIMEOUT_MS } = {}) => {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout,
			maxBuffer: GIT_MAX_BUFFER,
			env: {
				...process.env,
				GIT_EDITOR: "true",
				GIT_MERGE_AUTOEDIT: "no",
				GIT_OPTIONAL_LOCKS: "0",
				GIT_SEQUENCE_EDITOR: "true",
				GIT_TERMINAL_PROMPT: "0",
			},
		})
		return stdout
	} catch (err) {
		throw normalizeGitError(err)
	}
}

const gitBuffer = async (args, cwd) => {
	try {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
			encoding: "buffer",
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		})
		return stdout
	} catch (err) {
		throw normalizeGitError(err)
	}
}

const pathWithin = (root, path) => {
	const rel = relative(root, path)
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel))
}

async function checkedRealpath(path, status = 400) {
	try {
		return await realpath(path)
	} catch (err) {
		throw Object.assign(new Error(`path not found: ${path}`), { status, cause: err })
	}
}

async function directoryForDiscovery(path) {
	const abs = resolve(path)
	let stat
	try {
		stat = await lstat(abs)
	} catch (err) {
		throw Object.assign(new Error(`path not found: ${abs}`), { status: 404, cause: err })
	}
	return stat.isDirectory() ? abs : dirname(abs)
}

export async function findNearestGitRoot(startDir) {
	let dir = resolve(startDir)
	for (;;) {
		try {
			const stat = await lstat(join(dir, ".git"))
			if (stat.isDirectory() || stat.isFile() || stat.isSymbolicLink()) return dir
		} catch {}
		const parent = dirname(dir)
		if (parent === dir) return null
		dir = parent
	}
}

function cleanCommitLimit(limit) {
	const n = Number(limit)
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_COMMIT_LIMIT
	return Math.max(1, Math.min(MAX_COMMIT_LIMIT, Math.floor(n)))
}

function cleanCommitOffset(offset) {
	const n = Number(offset)
	if (!Number.isFinite(n) || n <= 0) return 0
	return Math.floor(n)
}

function cleanCommitHash(hash) {
	const value = typeof hash === "string" ? hash.trim() : ""
	if (!new RegExp(`^[0-9a-fA-F]{${MIN_COMMIT_HASH_LENGTH},64}$`).test(value)) {
		throw Object.assign(new Error("valid commit hash is required"), { status: 400 })
	}
	return value
}

function cleanComparisonMode(mode) {
	const value = typeof mode === "string" ? mode.trim().toLowerCase() : ""
	if (value === "auto" || value === "dirty") return value
	return "dirty"
}

function cleanChangeArea(area) {
	if (area === undefined || area === null || area === "") return undefined
	if (area === "staged" || area === "unstaged") return area
	throw Object.assign(new Error("valid source control change area is required"), { status: 400 })
}

function cleanCommitMessage(message) {
	const value = typeof message === "string" ? message.trim() : ""
	if (!value) throw Object.assign(new Error("commit message is required"), { status: 400 })
	if (Buffer.byteLength(value, "utf8") > MAX_COMMIT_MESSAGE_BYTES) {
		throw Object.assign(new Error("commit message is too large"), { status: 400 })
	}
	return value
}

function cleanCommitAction(action) {
	const value = typeof action === "string" && action ? action : "commit"
	if (!COMMIT_ACTIONS.has(value)) throw Object.assign(new Error("valid commit action is required"), { status: 400 })
	return value
}

async function gitConfigValue(root, key) {
	try {
		return (await git(["config", "--get", key], root)).trim()
	} catch (err) {
		if (err?.code === 1) return ""
		throw err
	}
}

async function requireGitIdentity(root) {
	const [name, email] = await Promise.all([
		gitConfigValue(root, "user.name"),
		gitConfigValue(root, "user.email"),
	])
	const missing = [
		...(!name ? ["user.name"] : []),
		...(!email ? ["user.email"] : []),
	]
	if (!missing.length) return
	const fields = missing.length === 2 ? `${missing[0]} and ${missing[1]}` : missing[0]
	throw Object.assign(new Error(`Git identity is incomplete: ${fields} ${missing.length === 1 ? "is" : "are"} not configured. Ask the agent to set up your Git name and email, then try again.`), {
		status: 409,
		code: "gitIdentityMissing",
	})
}

function gitCommandErrorMessage(err) {
	const stderr = typeof err?.stderr === "string" ? err.stderr.trim() : ""
	const stdout = typeof err?.stdout === "string" ? err.stdout.trim() : ""
	return stderr || stdout || (err instanceof Error ? err.message : String(err))
}

function normalizeGitError(err) {
	if (err?.code === "ENOENT") return Object.assign(new Error("Git is not available on this server"), { status: 503, cause: err })
	const detail = gitCommandErrorMessage(err)
	const filterProcessMissing = detail.split(/\r?\n/).some((line) =>
		/\bfilter-process:.*(?:command not found|:\s*not found)\s*$/i.test(line))
	if (!filterProcessMissing) return err
	const gitLfs = /\bgit-lfs\b/i.test(detail)
	const message = gitLfs
		? "Git LFS is required by this repository but is unavailable to the Cerex service. Working-tree status and actions are disabled; commit history remains available."
		: "A required Git filter is unavailable to the Cerex service. Working-tree status and actions are disabled; commit history remains available."
	return Object.assign(new Error(message), {
		status: 503,
		code: gitLfs ? "gitLfsUnavailable" : "gitFilterUnavailable",
		cause: err,
	})
}

const normalizeRelativeGitPath = (path) => path.replace(/\/+$/, "")

function cleanRelativeGitPath(path) {
	const value = normalizeRelativeGitPath(typeof path === "string" ? path : "")
	const parts = value.split("/")
	if (
		!value ||
		value.includes("\0") ||
		isAbsolute(value) ||
		parts.some((part) => !part || part === "." || part === "..")
	) {
		throw Object.assign(new Error("valid source control file path is required"), { status: 400 })
	}
	return value
}

function statusKind(xy) {
	const [index, worktree] = xy
	if (xy === "??") return "untracked"
	if (index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D")) return "conflict"
	if (index === "R" || worktree === "R") return "renamed"
	if (index === "A" || worktree === "A") return "added"
	if (index === "D" || worktree === "D") return "deleted"
	if (index === "M" || worktree === "M") return "modified"
	return "changed"
}

function diffStatusKind(status) {
	const code = String(status || "").charAt(0)
	if (code === "U") return "conflict"
	if (code === "R") return "renamed"
	if (code === "A" || code === "C") return "added"
	if (code === "D") return "deleted"
	if (code === "M") return "modified"
	return "changed"
}

export function parsePorcelainStatus(output, root) {
	const fields = output.split("\0")
	const changes = []
	for (let i = 0; i < fields.length;) {
		const record = fields[i++]
		if (!record) continue
		const xy = record.slice(0, 2)
		const relativePath = normalizeRelativeGitPath(record.slice(3))
		let oldRelativePath
		if ((xy[0] === "R" || xy[0] === "C" || xy[1] === "R" || xy[1] === "C") && i < fields.length) {
			oldRelativePath = normalizeRelativeGitPath(fields[i++] || "") || undefined
		}
		changes.push({
			path: join(root, relativePath),
			relativePath,
			...(oldRelativePath ? { oldRelativePath } : {}),
			index: xy[0],
			worktree: xy[1],
			status: xy,
			kind: statusKind(xy),
		})
	}
	return changes
}

function sourceControlChangeForArea(change, area) {
	const conflict = CONFLICT_STATUSES.has(change.status)
	const code = area === "staged" ? change.index : change.worktree
	if (area === "staged" && (conflict || !code || code === " " || code === "?")) return null
	if (area === "unstaged" && !conflict && (!code || code === " ")) return null
	const status = change.status === "??"
		? "??"
		: area === "staged" ? `${code} ` : ` ${conflict ? "U" : code}`
	const includeOldPath = area === "staged"
		? change.index === "R" || change.index === "C"
		: change.worktree === "R" || change.worktree === "C"
	const { oldRelativePath, ...rest } = change
	return {
		...rest,
		area,
		...(includeOldPath && oldRelativePath ? { oldRelativePath } : {}),
		status,
		kind: change.status === "??" ? "untracked" : conflict ? "conflict" : diffStatusKind(code),
	}
}

export function splitSourceControlChanges(changes) {
	return changes.reduce((result, change) => {
		const staged = sourceControlChangeForArea(change, "staged")
		const unstaged = sourceControlChangeForArea(change, "unstaged")
		if (staged) result.stagedChanges.push(staged)
		if (unstaged) result.unstagedChanges.push(unstaged)
		return result
	}, { stagedChanges: [], unstagedChanges: [] })
}

export function parseNameStatusChanges(output, root) {
	const fields = output.split("\0").filter(Boolean)
	const changes = []
	for (let i = 0; i < fields.length;) {
		const status = fields[i++] || ""
		if (!status) continue
		if ((status.startsWith("R") || status.startsWith("C")) && i + 1 < fields.length) {
			const oldRelativePath = normalizeRelativeGitPath(fields[i++] || "")
			const relativePath = normalizeRelativeGitPath(fields[i++] || "")
			if (!relativePath) continue
			changes.push({
				path: join(root, relativePath),
				relativePath,
				...(oldRelativePath ? { oldRelativePath } : {}),
				status,
				kind: diffStatusKind(status),
			})
			continue
		}
		const relativePath = normalizeRelativeGitPath(fields[i++] || "")
		if (!relativePath) continue
		changes.push({
			path: join(root, relativePath),
			relativePath,
			status,
			kind: diffStatusKind(status),
		})
	}
	return changes
}

async function sourceControlFileKind(path) {
	try {
		const pathStat = await stat(path)
		return pathStat.isDirectory() ? "directory" : "file"
	} catch (err) {
		if (MISSING_FILE_STAT_CODES.has(err?.code)) return "missing"
		return "unknown"
	}
}

async function withSourceControlFileKinds(changes) {
	return Promise.all(changes.map(async (change) => ({
		...change,
		fileKind: await sourceControlFileKind(change.path),
	})))
}

export function parseCommitList(output) {
	return output
		.split("\x1e")
		.map((record) => record.trim())
		.filter(Boolean)
		.map((record) => {
			const [hash, shortHash, author, date, subject] = record.split("\x1f")
			return { hash, shortHash, author, date, subject }
		})
}

async function repoBranch(root) {
	const [branch, head, shortHead] = await Promise.all([
		git(["rev-parse", "--abbrev-ref", "HEAD"], root).then((out) => out.trim()).catch(() => ""),
		git(["rev-parse", "HEAD"], root).then((out) => out.trim()).catch(() => ""),
		git(["rev-parse", "--short", "HEAD"], root).then((out) => out.trim()).catch(() => ""),
	])
	return {
		branch: branch && branch !== "HEAD" ? branch : "",
		detached: branch === "HEAD",
		head,
		shortHead,
	}
}

async function repoUpstreamStatus(root) {
	const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root)
		.then((out) => out.trim())
		.catch(() => "")
	if (!upstream) return { upstream: "" }
	const counts = await git(["rev-list", "--left-right", "--count", "HEAD...@{u}"], root)
		.then((out) => out.trim().match(/^(\d+)\s+(\d+)$/))
		.catch(() => null)
	return {
		upstream,
		...(counts ? { ahead: Number(counts[1]), behind: Number(counts[2]) } : {}),
	}
}

async function repoDirtyChanges(root) {
	const output = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root)
	return withSourceControlFileKinds(parsePorcelainStatus(output, root))
}

async function repoUntrackedChanges(root) {
	return (await repoDirtyChanges(root)).filter((change) => change.kind === "untracked")
}

function sourceControlChangeIdentity(change) {
	return `${change.status}:${change.oldRelativePath || ""}:${change.relativePath}`
}

async function repoBaseChanges(root, comparison) {
	const output = await git([
		"diff",
		"--name-status",
		"--find-renames",
		"-z",
		comparison.commit,
		"--",
	], root)
	const changes = parseNameStatusChanges(output, root)
	const seen = new Set(changes.map(sourceControlChangeIdentity))
	const untracked = await repoUntrackedChanges(root)
	return withSourceControlFileKinds([
		...changes,
		...untracked.filter((change) => !seen.has(sourceControlChangeIdentity(change))),
	])
}

async function repoChanges(root, comparison = { mode: "dirty" }) {
	return comparison.mode === "base" ? repoBaseChanges(root, comparison) : repoDirtyChanges(root)
}

async function repoWorkingTree(root, comparison) {
	try {
		return { changes: await repoChanges(root, comparison) }
	} catch (err) {
		if (err?.code !== "gitLfsUnavailable" && err?.code !== "gitFilterUnavailable") throw err
		return { changes: [], workingTreeError: err.message }
	}
}

async function repoCommitCount(root) {
	const output = await git(["rev-list", "--count", "HEAD"], root).catch(() => "")
	const count = Number(output.trim())
	return Number.isFinite(count) && count >= 0 ? count : 0
}

async function repoCommits(root, { offset = 0, limit } = {}) {
	const output = await git([
		"log",
		"--date-order",
		`--skip=${cleanCommitOffset(offset)}`,
		`-n${cleanCommitLimit(limit)}`,
		"--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e",
	], root).catch(() => "")
	return parseCommitList(output)
}

export function parseCommitDetail(output) {
	const [hash = "", shortHash = "", author = "", authorEmail = "", date = "", parentsText = "", subject = "", body = ""] = output.split("\0")
	return {
		hash,
		shortHash,
		author,
		authorEmail,
		date,
		parents: parentsText ? parentsText.split(" ").filter(Boolean) : [],
		subject,
		body: body.replace(/\n+$/, ""),
	}
}

export function parseCommitFiles(output) {
	const fields = output.split("\0").filter(Boolean)
	const files = []
	for (let i = 0; i < fields.length;) {
		const status = fields[i++] || ""
		const path = fields[i++] || ""
		if (!status || !path) continue
		if ((status.startsWith("R") || status.startsWith("C")) && i < fields.length) {
			const oldPath = path
			const newPath = fields[i++] || ""
			files.push({ status, path: newPath || oldPath, oldPath })
		} else files.push({ status, path })
	}
	return files
}

async function repoCommitDetail(root, hash) {
	const safeHash = cleanCommitHash(hash)
	const commit = parseCommitDetail(await git([
		"show",
		"-s",
		"--format=%H%x00%h%x00%an%x00%ae%x00%aI%x00%P%x00%s%x00%b",
		safeHash,
	], root))
	if (!commit.hash) throw Object.assign(new Error("commit not found"), { status: 404 })
	const files = parseCommitFiles(await git([
		"diff-tree",
		"--root",
		"--no-commit-id",
		"--name-status",
		"-r",
		"-z",
		commit.hash,
	], root).catch(() => ""))
	return { ...commit, files }
}

async function repoBlob(root, relativePath, rev = "HEAD") {
	try {
		return await gitBuffer(["show", `${rev}:${relativePath}`], root)
	} catch (err) {
		if (err?.status) throw err
		return null
	}
}

async function repoIndexBlob(root, relativePath) {
	try {
		return await gitBuffer(["show", `:${relativePath}`], root)
	} catch (err) {
		if (err?.status) throw err
		return null
	}
}

async function repoHasHead(root) {
	return git(["rev-parse", "--verify", "HEAD"], root).then(() => true, () => false)
}

async function resolvedCommit(root, hash, source = "manual") {
	const safeHash = cleanCommitHash(hash)
	const commit = await git(["rev-parse", "--verify", `${safeHash}^{commit}`], root)
		.then((out) => out.trim())
		.catch(() => "")
	if (!commit) throw Object.assign(new Error("commit not found"), { status: 404 })
	const shortHash = await git(["rev-parse", "--short", commit], root)
		.then((out) => out.trim())
		.catch(() => commit.slice(0, 12))
	return { commit, shortHash, source }
}

async function branchConfig(root, branch, key, legacyKey) {
	if (!branch) return ""
	return await git(["config", "--get", `branch.${branch}.${key}`], root)
		.then((out) => out.trim())
		.catch(() => "")
		|| await git(["config", "--get", `branch.${branch}.${legacyKey}`], root)
			.then((out) => out.trim())
			.catch(() => "")
}

async function repoIntegrationTargetMergeBase(root, integrationTarget) {
	if (!integrationTarget) return ""
	const target = await git(["show-ref", "--verify", "--hash", `refs/heads/${integrationTarget}`], root)
		.then((out) => out.trim())
		.catch(() => "")
	if (!target) return ""
	return git(["merge-base", "HEAD", target], root)
		.then((out) => out.trim())
		.catch(() => "")
}

async function repoWorktreeBase(root, branch) {
	if (!branch) return undefined
	const [integrationTarget, initialHead] = await Promise.all([
		branchConfig(root, branch, INTEGRATION_TARGET_CONFIG, LEGACY_INTEGRATION_TARGET_CONFIG),
		branchConfig(root, branch, INITIAL_HEAD_CONFIG, LEGACY_INITIAL_HEAD_CONFIG),
	])
	const mergeBase = await repoIntegrationTargetMergeBase(root, integrationTarget)
	if (mergeBase) {
		const resolved = await resolvedCommit(root, mergeBase, "worktree").catch(() => undefined)
		if (resolved) return resolved
	}
	return initialHead
		? resolvedCommit(root, initialHead, "worktree").catch(() => undefined)
		: undefined
}

async function repoComparison(root, options = {}, branchInfo = undefined) {
	const base = typeof options.base === "string" && options.base.trim() ? options.base.trim() : ""
	const mode = cleanComparisonMode(options.comparison)
	const branch = branchInfo ?? await repoBranch(root)
	const defaultBaseInfo = await repoWorktreeBase(root, branch.branch)
	const defaultBase = defaultBaseInfo ? { mode: "base", ...defaultBaseInfo } : undefined
	if (base) return {
		comparison: { mode: "base", ...await resolvedCommit(root, base, "manual") },
		defaultBase,
	}
	if (mode === "auto" && defaultBase) return {
		comparison: defaultBase,
		defaultBase,
	}
	return {
		comparison: { mode: "dirty" },
		defaultBase,
	}
}

async function workingTreeFile(repo, relativePath) {
	const fullPath = join(repo.root, relativePath)
	let stat
	try {
		stat = await lstat(fullPath)
	} catch (err) {
		if (MISSING_FILE_STAT_CODES.has(err?.code)) return null
		throw err
	}
	if (stat.isSymbolicLink()) return Buffer.from(await readlink(fullPath), "utf8")
	if (!stat.isFile()) return null
	const realFilePath = await checkedRealpath(fullPath, 404)
	if (!pathWithin(repo.workspaceRoot, realFilePath)) throw Object.assign(new Error("source control file is outside the workspace root"), { status: 403 })
	return readFile(fullPath)
}

function decodeChangeText(buffer) {
	if (!buffer || buffer.length === 0) return { text: "" }
	if (buffer.length > MAX_CHANGE_TEXT_BYTES) return { text: "", tooLarge: true }
	if (buffer.includes(0)) return { text: "", binary: true }
	return { text: buffer.toString("utf8") }
}

function changeMatchesPath(change, relativePath) {
	return change.relativePath === relativePath || change.oldRelativePath === relativePath
}

function changeBasePath(change) {
	if (change.oldRelativePath) return change.oldRelativePath
	if (change.kind === "added" || change.kind === "untracked") return ""
	return change.relativePath
}

function sourceControlChangeDiffResponse(repo, change, oldPath, newPath, oldBuffer, newBuffer) {
	const oldText = decodeChangeText(oldBuffer)
	const newText = decodeChangeText(newBuffer)
	const binary = oldText.binary || newText.binary || undefined
	const tooLarge = oldText.tooLarge || newText.tooLarge || undefined

	return {
		isRepo: true,
		path: repo.path,
		root: repo.root,
		workspaceRoot: repo.workspaceRoot,
		change,
		oldPath,
		newPath,
		oldText: binary || tooLarge ? "" : oldText.text,
		newText: binary || tooLarge ? "" : newText.text,
		...(binary ? { binary: true } : {}),
		...(tooLarge ? { tooLarge: true } : {}),
		generatedAt: new Date().toISOString(),
	}
}

async function unchangedSourceControlFile(repo, relativePath, comparison = { mode: "dirty" }) {
	const fullPath = checkedRepoTarget(repo, relativePath)
	const oldRev = comparison.mode === "base" ? comparison.commit : "HEAD"
	const [oldBuffer, newBuffer, fileKind] = await Promise.all([
		repoBlob(repo.root, relativePath, oldRev),
		workingTreeFile(repo, relativePath),
		sourceControlFileKind(fullPath),
	])
	if (!oldBuffer && !newBuffer) throw Object.assign(new Error("source control change not found"), { status: 404 })
	return sourceControlChangeDiffResponse(repo, {
		path: fullPath,
		relativePath,
		fileKind,
		index: " ",
		worktree: " ",
		status: "  ",
		kind: "changed",
	}, relativePath, relativePath, oldBuffer, newBuffer)
}

function gitPathspecsForChange(change) {
	return [...new Set([
		change.relativePath,
		change.oldRelativePath,
	].filter(Boolean))]
}

function checkedRepoTarget(repo, relativePath) {
	const target = resolve(repo.root, relativePath)
	if (!pathWithin(repo.root, target) || !pathWithin(repo.workspaceRoot, target)) {
		throw Object.assign(new Error("source control file is outside the workspace root"), { status: 403 })
	}
	return target
}

async function discardUntrackedChange(repo, change) {
	const target = checkedRepoTarget(repo, change.relativePath)
	await rm(target, { recursive: true, force: true })
}

async function discardTrackedChange(repo, change) {
	const pathspecs = gitPathspecsForChange(change)
	pathspecs.forEach((pathspec) => checkedRepoTarget(repo, pathspec))
	await git(["restore", "--worktree", "--", ...pathspecs], repo.root)
}

async function resolveChangeForMutation(repo, file, area) {
	if (!file) return null
	const relativePath = cleanRelativeGitPath(file)
	checkedRepoTarget(repo, relativePath)
	const groups = splitSourceControlChanges(await repoDirtyChanges(repo.root))
	return groups[area === "staged" ? "stagedChanges" : "unstagedChanges"]
		.find((change) => changeMatchesPath(change, relativePath)) ?? null
}

async function resolveSourceControlRepo({ path, fallbackCwd = process.cwd(), workspaceRoot = "/" } = {}) {
	const requestedPath = typeof path === "string" && path.trim() ? path.trim() : fallbackCwd
	if (!isAbsolute(requestedPath)) throw Object.assign(new Error("source control path must be absolute"), { status: 400 })

	const rootLimit = await checkedRealpath(workspaceRoot || "/", 400)
	const realRequestedPath = await checkedRealpath(requestedPath, 404)
	if (!pathWithin(rootLimit, realRequestedPath)) throw Object.assign(new Error("source control path is outside the workspace root"), { status: 403 })

	const startDir = await directoryForDiscovery(realRequestedPath)
	const repoRoot = await findNearestGitRoot(startDir)
	if (!repoRoot) return {
		isRepo: false,
		path: startDir,
		workspaceRoot: rootLimit,
		root: "",
	}
	const realRepoRoot = await checkedRealpath(repoRoot, 400)
	if (!pathWithin(rootLimit, realRepoRoot)) throw Object.assign(new Error("Git repository is outside the workspace root"), { status: 403 })
	return {
		isRepo: true,
		path: startDir,
		workspaceRoot: rootLimit,
		root: realRepoRoot,
	}
}

export async function sourceControlRepoInfo(options = {}) {
	const repo = await resolveSourceControlRepo(options)
	return {
		isRepo: repo.isRepo,
		path: repo.path,
		workspaceRoot: repo.workspaceRoot,
		root: repo.root,
	}
}

export async function sourceControlSnapshot(options = {}) {
	const repo = await resolveSourceControlRepo(options)
	if (!repo.isRepo) {
		return {
			isRepo: false,
			path: repo.path,
			workspaceRoot: repo.workspaceRoot,
			changes: [],
			stagedChanges: [],
			unstagedChanges: [],
			commitCount: 0,
			commits: [],
			comparison: { mode: "dirty" },
			generatedAt: new Date().toISOString(),
		}
	}

	const branch = await repoBranch(repo.root)
	const { comparison, defaultBase } = await repoComparison(repo.root, options, branch)
	const [upstreamStatus, workingTree, commitCount] = await Promise.all([
		repoUpstreamStatus(repo.root),
		repoWorkingTree(repo.root, comparison),
		repoCommitCount(repo.root),
	])
	const changeGroups = comparison.mode === "dirty" ? splitSourceControlChanges(workingTree.changes) : {}

	return {
		isRepo: true,
		path: repo.path,
		root: repo.root,
		workspaceRoot: repo.workspaceRoot,
		...branch,
		...upstreamStatus,
		...workingTree,
		...changeGroups,
		commitCount,
		comparison,
		...(defaultBase ? { defaultBase } : {}),
		generatedAt: new Date().toISOString(),
	}
}

export async function sourceControlCommits({ offset = 0, limit, ...options } = {}) {
	const repo = await resolveSourceControlRepo(options)
	if (!repo.isRepo) return {
		isRepo: false,
		path: repo.path,
		workspaceRoot: repo.workspaceRoot,
		commitCount: 0,
		commits: [],
	}
	const [branch, commitCount, commits] = await Promise.all([
		repoBranch(repo.root),
		repoCommitCount(repo.root),
		repoCommits(repo.root, { offset, limit }),
	])
	return {
		isRepo: true,
		path: repo.path,
		root: repo.root,
		workspaceRoot: repo.workspaceRoot,
		...branch,
		commitCount,
		offset: cleanCommitOffset(offset),
		limit: cleanCommitLimit(limit),
		commits,
	}
}

export async function sourceControlCommit({ hash, ...options } = {}) {
	const repo = await resolveSourceControlRepo(options)
	if (!repo.isRepo) throw Object.assign(new Error("Git repository not found"), { status: 404 })
	return {
		isRepo: true,
		path: repo.path,
		root: repo.root,
		workspaceRoot: repo.workspaceRoot,
		commit: await repoCommitDetail(repo.root, hash),
	}
}

export async function sourceControlChange({ file, area: requestedArea, ...options } = {}) {
	const repo = await resolveSourceControlRepo(options)
	if (!repo.isRepo) throw Object.assign(new Error("Git repository not found"), { status: 404 })
	const relativePath = cleanRelativeGitPath(file)
	const area = cleanChangeArea(requestedArea)
	const { comparison, defaultBase } = await repoComparison(repo.root, options)
	const changes = await repoChanges(repo.root, comparison)
	const areaChanges = comparison.mode === "dirty" && area
		? splitSourceControlChanges(changes)[area === "staged" ? "stagedChanges" : "unstagedChanges"]
		: changes
	const change = areaChanges.find((candidate) => changeMatchesPath(candidate, relativePath))
	if (!change && area) throw Object.assign(new Error("source control change not found"), { status: 404 })
	if (!change) return {
		...await unchangedSourceControlFile(repo, relativePath, comparison),
		comparison,
		...(defaultBase ? { defaultBase } : {}),
	}

	const basePath = changeBasePath(change)
	const oldRev = comparison.mode === "base" ? comparison.commit : "HEAD"
	const [oldBuffer, newBuffer] = area === "staged"
		? await Promise.all([
			basePath ? repoBlob(repo.root, basePath, "HEAD") : null,
			repoIndexBlob(repo.root, change.relativePath),
		])
		: area === "unstaged"
			? await Promise.all([
				change.kind === "untracked" ? null : repoIndexBlob(repo.root, basePath || change.relativePath),
				workingTreeFile(repo, change.relativePath),
			])
			: await Promise.all([
				basePath ? repoBlob(repo.root, basePath, oldRev) : null,
				workingTreeFile(repo, change.relativePath),
			])
	return {
		...sourceControlChangeDiffResponse(repo, change, basePath || change.relativePath, change.relativePath, oldBuffer, newBuffer),
		comparison,
		...(defaultBase ? { defaultBase } : {}),
	}
}

export async function sourceControlDiscardChange({ file, ...options } = {}) {
	const repo = await resolveSourceControlRepo(options)
	if (!repo.isRepo) throw Object.assign(new Error("Git repository not found"), { status: 404 })
	const change = await resolveChangeForMutation(repo, file, "unstaged")
	if (!change) return sourceControlSnapshot(options)
	if (change.kind === "conflict") throw Object.assign(new Error("cannot discard an unresolved conflict"), { status: 409 })

	if (change.kind === "untracked") await discardUntrackedChange(repo, change)
	else await discardTrackedChange(repo, change)

	return sourceControlSnapshot(options)
}

export async function sourceControlStage({ file, ...options } = {}) {
	const repo = await resolveSourceControlRepo(options)
	if (!repo.isRepo) throw Object.assign(new Error("Git repository not found"), { status: 404 })
	const change = await resolveChangeForMutation(repo, file, "unstaged")
	if (file && !change) return sourceControlSnapshot(options)
	const pathspecs = change ? gitPathspecsForChange(change) : ["."]
	await git(["add", "--all", "--", ...pathspecs], repo.root)
	return sourceControlSnapshot(options)
}

export async function sourceControlUnstage({ file, ...options } = {}) {
	const repo = await resolveSourceControlRepo(options)
	if (!repo.isRepo) throw Object.assign(new Error("Git repository not found"), { status: 404 })
	const change = await resolveChangeForMutation(repo, file, "staged")
	if (file && !change) return sourceControlSnapshot(options)
	const pathspecs = change ? gitPathspecsForChange(change) : ["."]
	pathspecs.forEach((pathspec) => pathspec === "." || checkedRepoTarget(repo, pathspec))
	if (await repoHasHead(repo.root)) await git(["reset", "--quiet", "HEAD", "--", ...pathspecs], repo.root)
	else await git(["rm", "--cached", "-r", "--ignore-unmatch", "--", ...pathspecs], repo.root)
	return sourceControlSnapshot(options)
}

export async function sourceControlCreateCommit({ message, action: requestedAction, ...options } = {}) {
	const repo = await resolveSourceControlRepo(options)
	if (!repo.isRepo) throw Object.assign(new Error("Git repository not found"), { status: 404 })
	const cleanMessage = cleanCommitMessage(message)
	const action = cleanCommitAction(requestedAction)
	const { stagedChanges } = splitSourceControlChanges(await repoDirtyChanges(repo.root))
	if (action === "amend") {
		if (!await repoHasHead(repo.root)) throw Object.assign(new Error("there is no commit to amend"), { status: 409 })
	} else if (stagedChanges.length === 0) {
		throw Object.assign(new Error("there are no staged changes to commit"), { status: 409 })
	}

	await requireGitIdentity(repo.root)
	await git(["commit", ...(action === "amend" ? ["--amend"] : []), "--quiet", "--message", cleanMessage], repo.root)
	const remoteAction = action === "commit-and-sync" ? "sync" : action === "commit-and-push" ? "push" : ""
	const remoteFailure = remoteAction ? await runRemoteOperation(repo.root, remoteAction) : null
	const operationError = remoteFailure
		? `Commit succeeded, but ${remoteAction} failed during ${remoteFailure.phase}: ${remoteFailure.error}`
		: ""

	return {
		snapshot: await sourceControlSnapshot(options),
		operation: {
			action,
			committed: true,
			completed: !operationError,
			...(operationError ? { error: operationError } : {}),
		},
	}
}

async function runRemoteOperation(root, action) {
	const phases = action === "sync" ? ["pull", "push"] : ["push"]
	for (const phase of phases) {
		try {
			await git([phase], root, { timeout: GIT_REMOTE_TIMEOUT_MS })
		} catch (err) {
			return { phase, error: gitCommandErrorMessage(err) }
		}
	}
	return null
}

export async function sourceControlSync(options = {}) {
	const repo = await resolveSourceControlRepo(options)
	if (!repo.isRepo) throw Object.assign(new Error("Git repository not found"), { status: 404 })
	const failure = await runRemoteOperation(repo.root, "sync")
	return {
		snapshot: await sourceControlSnapshot(options),
		operation: {
			action: "sync",
			completed: !failure,
			...(failure ? { error: `Sync failed during ${failure.phase}: ${failure.error}` } : {}),
		},
	}
}
