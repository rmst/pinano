import { cp, mkdir, readdir, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"

import { sessionWorkspacePath } from "./paths.js"
import { pathIsWithin } from "./sandbox-paths.js"

const projectLocalWorktreeMarker = "/.pinano/wt/"

async function pathExists(path) {
	try {
		await stat(path)
		return true
	} catch (err) {
		if (err?.code === "ENOENT") return false
		throw err
	}
}

export async function ensureSessionWorkspaceDir(dir) {
	await mkdir(join(dir, "tmp"), { recursive: true })
	return dir
}

export async function ensureSessionWorkspace(sessionId) {
	return ensureSessionWorkspaceDir(sessionWorkspacePath(sessionId))
}

export function remapSessionWorkspacePath(path, oldSessionDir, newSessionDir) {
	return remapSessionWorkspacePathWithMappings(path, [{ sourceDir: oldSessionDir, targetDir: newSessionDir }])
}

function normalizedPathMappings(mappings) {
	const seen = new Set()
	return mappings
		.filter((mapping) => mapping?.sourceDir && mapping?.targetDir)
		.map((mapping) => ({
			sourceDir: resolve(mapping.sourceDir),
			targetDir: resolve(mapping.targetDir),
		}))
		.filter((mapping) => {
			const key = `${mapping.sourceDir}\0${mapping.targetDir}`
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
}

function bestPathMapping(path, mappings) {
	const absolute = resolve(path)
	return normalizedPathMappings(mappings)
		.filter((mapping) => pathIsWithin(mapping.sourceDir, absolute))
		.sort((a, b) => b.sourceDir.length - a.sourceDir.length)[0]
}

export function remapSessionWorkspacePathWithMappings(path, mappings) {
	if (!path) return undefined
	const match = bestPathMapping(path, mappings)
	if (!match) return undefined
	const rel = relative(match.sourceDir, resolve(path))
	return rel ? resolve(match.targetDir, rel) : match.targetDir
}

function projectLocalWorktreeRepoRoot(path) {
	const absolute = resolve(path)
	const index = absolute.indexOf(projectLocalWorktreeMarker)
	return index < 0 ? undefined : absolute.slice(0, index) || "/"
}

function branchPath(path, mappings) {
	if (!path) return undefined
	const match = bestPathMapping(path, mappings)
	if (match) {
		const rel = relative(match.sourceDir, resolve(path))
		const newPath = rel ? resolve(match.targetDir, rel) : match.targetDir
		return {
			oldPath: path,
			newPath,
			changed: newPath !== path,
			reason: "session-workspace",
		}
	}
	const repoRoot = projectLocalWorktreeRepoRoot(path)
	return repoRoot ? {
		oldPath: path,
		newPath: repoRoot,
		changed: repoRoot !== path,
		reason: "project-local-worktree",
	} : undefined
}

async function copySessionFiles(sourceDir, targetDir) {
	if (!await pathExists(sourceDir)) return
	await mkdir(targetDir, { recursive: true })
	for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
		await cp(join(sourceDir, entry.name), join(targetDir, entry.name), {
			recursive: true,
			force: true,
			preserveTimestamps: true,
			verbatimSymlinks: true,
		})
	}
}

export function branchNoticeMessageText(report) {
	const lines = [
		`This session was branched from session ${report.sourceSessionId} to ${report.targetSessionId}.`,
		"",
		"Use the new session workspace:",
		report.targetDir,
		"",
		"Do not continue editing files under the old session workspace:",
		report.sourceDir,
		"",
		"Any worktrees created by the parent session may still be in use by that session. Unless the user explicitly asks to reuse an existing worktree, create new worktrees for this session's work.",
	]
	if (report.cwd?.changed) {
		lines.push("", "The current tool cwd was remapped:", `${report.cwd.oldPath} -> ${report.cwd.newPath}`)
	}
	return lines.join("\n")
}

export function branchNoticeMessage(report) {
	return {
		role: "developer",
		content: [{ type: "text", text: branchNoticeMessageText(report) }],
		timestamp: Date.now(),
		pinanoHidden: true,
		pinanoBranchNotice: true,
	}
}

export async function branchSessionWorkspace(options) {
	const sourceDir = sessionWorkspacePath(options.sourceSessionId)
	const targetDir = await ensureSessionWorkspace(options.targetSessionId)
	const pathMappings = normalizedPathMappings([
		{ sourceDir, targetDir },
		...(options.pathMappings ?? []),
	])
	await copySessionFiles(sourceDir, targetDir)
	return {
		sourceSessionId: options.sourceSessionId,
		targetSessionId: options.targetSessionId,
		sourceDir,
		targetDir,
		cwd: branchPath(options.cwd, pathMappings),
		remapPath: (path) => branchPath(path, pathMappings)?.newPath,
	}
}
