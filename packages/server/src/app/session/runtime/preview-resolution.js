import { open } from "node:fs/promises"
import { resolve } from "node:path"

import { previewPublicUrl } from "../../preview/manifest.js"
import { pathIsWithin } from "../../sandbox/paths.js"

export const MAX_PREVIEW_UI_FILE_BYTES = 256 * 1024

export function previewItemFromDefinition(scope, definition, publicUrl, routingSlug) {
	const scopeId = scope.scopeId
	return {
		scope: scope.kind,
		scopeId,
		ownerSessionId: scope.sessionId,
		name: definition.name,
		description: definition.description,
		publicUrl: publicUrl ? previewPublicUrl({
			publicUrl,
			name: definition.name,
			scopeId,
			routingSlug,
			path: definition.entryPath ?? "/",
		}) : undefined,
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
		}, target.definition, publicUrl, routingSlug),
		...(url ? { url } : {}),
	}
}

export function previewSourcePath(source) {
	if (!source || typeof source !== "object") return undefined
	if (source.kind === "preview-js" && source.path) return source.path
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
