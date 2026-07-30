import { open, readFile, realpath, stat } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"

import { previewPublicUrl } from "../../preview/manifest.js"
import { previewSourcePathForRoute } from "../../preview/source-mapping.js"
import { pathIsWithin } from "../../sandbox/paths.js"

export const MAX_PREVIEW_UI_FILE_BYTES = 256 * 1024

function previewTargetSourceRoot(target) {
	if (target?.sourceRoot) return resolve(target.sourceRoot)
	if (target?.scopeKind !== "session" && target?.projectDir) return resolve(target.projectDir)
	return undefined
}

export async function readPreviewTargetSource(workspace, target, value, maxBytes = 1) {
	const sourceRoot = previewTargetSourceRoot(target)
	if (!sourceRoot || typeof value !== "string" || !isAbsolute(value)) return undefined
	const requested = resolve(value)
	if (!pathIsWithin(sourceRoot, requested)) return undefined
	const sessionDir = target.sessionDir ? resolve(target.sessionDir) : undefined
	let result
	let scope = "project"
	if (sessionDir && pathIsWithin(sessionDir, requested)) {
		const path = resolve(await realpath(requested))
		if (!pathIsWithin(sourceRoot, path) || !pathIsWithin(sessionDir, path)) return undefined
		const info = await stat(path)
		if (!info.isFile()) return undefined
		result = info.size > maxBytes
			? { path, size: info.size, tooLarge: true }
			: { path, size: info.size, text: await readFile(path, "utf-8") }
		scope = "session"
	} else {
		result = await workspace.previews.readSource(requested, maxBytes)
		if (!pathIsWithin(sourceRoot, resolve(result.path))) return undefined
	}
	return {
		...result,
		sourceFile: {
			path: result.path,
			root: sourceRoot,
			scope,
			...(scope === "session" && target.sessionId ? { sessionId: target.sessionId } : {}),
		},
	}
}

export async function mappedPreviewTargetSource(workspace, target, value, maxBytes = 1) {
	if (target?.definition?.kind !== "process") return undefined
	const sourcePath = previewSourcePathForRoute(target.definition, value, previewTargetSourceRoot(target))
	if (!sourcePath) return undefined
	try {
		return await readPreviewTargetSource(workspace, target, sourcePath, maxBytes)
	} catch {
		return undefined
	}
}

export async function resolvedPreviewItemFromTarget(workspace, target, publicUrl, routingSlug, url = undefined) {
	const source = await mappedPreviewTargetSource(workspace, target, url ?? target.entryPath ?? target.definition.entryPath ?? "/")
	const resolvedTarget = await resolvedPreviewTarget(workspace, target)
	return previewItemFromTarget({
		...resolvedTarget,
		sourcePath: source?.path,
		sourceFile: source?.sourceFile,
	}, publicUrl, routingSlug, url)
}

export async function resolvedPreviewTarget(workspace, target) {
	if (target.definition.kind !== "process") return target
	if (target.environmentId && target.cwd) return target
	return {
		...target,
		...await workspace.previews.process.describe(target.executionRoot, target.definition.cwd),
	}
}

export function previewItemFromDefinition(scope, definition, publicUrl, routingSlug) {
	const scopeId = scope.scopeId
	const entryPath = scope.entryPath ?? definition.entryPath ?? "/"
	const sourcePath = scope.sourcePath ?? (definition.kind === "static" ? definition.source?.documentPath : undefined)
	return {
		scope: scope.kind,
		scopeId,
		ownerSessionId: scope.sessionId,
		name: definition.name,
		kind: definition.kind,
		description: definition.description,
		publicUrl: publicUrl ? previewPublicUrl({
			publicUrl,
			name: definition.name,
			scopeId,
			routingSlug,
			path: entryPath,
		}) : undefined,
		configPath: definition.configPath ?? definition.source?.configPath,
		...(scope.executionRoot ? { executionRoot: scope.executionRoot } : {}),
		...(scope.environmentId ? { environmentId: scope.environmentId } : {}),
		...(scope.cwd ? { cwd: scope.cwd } : {}),
		...(sourcePath ? { sourcePath } : {}),
		...(scope.sourceFile ? { sourceFile: scope.sourceFile } : {}),
		...(definition.kind === "static" ? { staticRoot: definition.source.path } : {}),
		source: definition.source,
		logPath: scope.logPath,
	}
}

export function previewItemFromTarget(target, publicUrl, routingSlug, url = undefined) {
	return {
		...previewItemFromDefinition({
			kind: target.scopeKind,
			scopeId: target.scopeId,
			sessionId: target.sessionId,
			logPath: target.logPath,
			executionRoot: target.executionRoot,
			environmentId: target.environmentId,
			cwd: target.cwd,
			entryPath: target.entryPath,
			sourcePath: target.sourcePath,
			sourceFile: target.sourceFile,
		}, target.definition, publicUrl, routingSlug),
		...(url ? { url } : {}),
	}
}

export function previewSourcePath(source) {
	if (!source || typeof source !== "object") return undefined
	if (source.kind === "preview-json" && source.path) return source.path
	if (source.kind === "static-directory") return source.configPath ?? source.documentPath
	return undefined
}

export function urlPort(url) {
	return url.port || (url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "")
}

export async function readTextFileTail(path, maxBytes = MAX_PREVIEW_UI_FILE_BYTES) {
	if (!path) return ""
	const limit = Math.max(0, maxBytes)
	if (limit === 0) return ""
	let file
	try {
		file = await open(path, "r")
		const info = await file.stat()
		if (!info.isFile()) return ""
		const start = Math.max(0, info.size - limit)
		const length = info.size - start
		const buffer = Buffer.alloc(length)
		const { bytesRead } = await file.read(buffer, 0, length, start)
		return buffer.subarray(0, bytesRead).toString("utf-8")
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return ""
		throw err
	} finally {
		await file?.close()
	}
}

export function longestContainingRoot(records, filePath) {
	return records
		.filter((record) => pathIsWithin(resolve(record.rootPath), filePath))
		.sort((a, b) => b.rootPath.length - a.rootPath.length || a.rootPath.localeCompare(b.rootPath))[0]
}
