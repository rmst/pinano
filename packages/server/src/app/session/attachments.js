import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"

import { sessionWorkspacePath } from "../paths.js"
import { sessionWorkspaceDirName } from "./workspace-names.js"

export const SESSION_ATTACHMENT_KIND_IMAGE = "image"
export const SESSION_ATTACHMENT_VARIANT_DISPLAY = "display"
export const SESSION_ATTACHMENT_VARIANT_ORIGINAL = "original"
export const SESSION_ATTACHMENT_STORAGE_LOCAL = "session-file"
export const SESSION_USER_INPUT_DIRNAME = "user-input"

const MIME_EXTENSIONS = new Map([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
])

/** @param {string | undefined | null} mimeType */
export function imageExtensionForMime(mimeType) {
	return MIME_EXTENSIONS.get(String(mimeType || "").toLowerCase()) ?? "bin"
}

/** @param {number} number */
export function paddedAttachmentNumber(number) {
	return String(number).padStart(6, "0")
}

/**
 * Prompt-pasted image filenames are stable user-facing references within the session workspace.
 * @param {number} number
 * @param {string | undefined | null} mimeType
 * @param {string} [variant]
 */
export function promptImageAttachmentFilename(number, mimeType, variant = SESSION_ATTACHMENT_VARIANT_DISPLAY) {
	const suffix = variant === SESSION_ATTACHMENT_VARIANT_ORIGINAL ? "-original" : ""
	return `pasted-image-${paddedAttachmentNumber(number)}${suffix}.${imageExtensionForMime(mimeType)}`
}

/**
 * Derive the session workspace root that belongs to a non-default test/copy database path.
 * Production paths are `$CEREX_HOME/data/server.sqlite`, so the workspace root is the sibling `$CEREX_HOME/sessions`.
 * For standalone test DB paths, use a `sessions/` sibling next to the copied database.
 * @param {string} dbPath
 * @param {string} sessionId
 */
export function sessionWorkspacePathForDbPath(dbPath, sessionId) {
	const dbDir = dirname(resolve(dbPath))
	const home = basename(dbDir) === "data" ? dirname(dbDir) : dbDir
	return join(home, "sessions", sessionWorkspaceDirName(sessionId))
}

/**
 * @param {string} sessionId
 * @param {{ sessionDir?: string, dbPath?: string }} [options]
 */
export function attachmentSessionWorkspacePath(sessionId, options = {}) {
	if (options.sessionDir) return options.sessionDir
	if (options.dbPath) return sessionWorkspacePathForDbPath(options.dbPath, sessionId)
	return sessionWorkspacePath(sessionId)
}

/**
 * @param {string} sessionId
 * @param {{ sessionDir?: string, dbPath?: string }} [options]
 */
export function sessionUserInputDir(sessionId, options = {}) {
	return join(attachmentSessionWorkspacePath(sessionId, options), SESSION_USER_INPUT_DIRNAME)
}

/** @param {string} data */
export function base64ToBuffer(data) {
	return Buffer.from(String(data || ""), "base64")
}

/** @param {Buffer} buffer */
export function sha256Hex(buffer) {
	return createHash("sha256").update(buffer).digest("hex")
}

/**
 * @param {string} sessionId
 * @param {number} number
 * @param {{ data: string, mimeType?: string, widthPx?: number, heightPx?: number, original?: { data: string, mimeType?: string, widthPx?: number, heightPx?: number } }} image
 * @param {{ sessionDir?: string, dbPath?: string }} [options]
 */
export function writePromptImageAttachmentFilesSync(sessionId, number, image, options = {}) {
	const userInputDir = sessionUserInputDir(sessionId, options)
	mkdirSync(userInputDir, { recursive: true })
	const writeVariant = (variant, source) => {
		const filename = promptImageAttachmentFilename(number, source.mimeType, variant)
		const storageKey = `${SESSION_USER_INPUT_DIRNAME}/${filename}`
		const filePath = join(userInputDir, filename)
		const tempPath = join(userInputDir, `.${filename}.${process.pid}.${randomUUID()}.tmp`)
		const buffer = base64ToBuffer(source.data)
		try {
			writeFileSync(tempPath, buffer)
			renameSync(tempPath, filePath)
		} catch (err) {
			rmSync(tempPath, { force: true })
			throw err
		}
		return {
			variant,
			storageBackend: SESSION_ATTACHMENT_STORAGE_LOCAL,
			storageKey,
			filename,
			filePath,
			mimeType: source.mimeType ?? "application/octet-stream",
			byteSize: buffer.byteLength,
			sha256: sha256Hex(buffer),
			widthPx: Number.isFinite(source.widthPx) && source.widthPx > 0 ? source.widthPx : null,
			heightPx: Number.isFinite(source.heightPx) && source.heightPx > 0 ? source.heightPx : null,
		}
	}
	return {
		display: writeVariant(SESSION_ATTACHMENT_VARIANT_DISPLAY, image),
		...(image.original?.data ? { original: writeVariant(SESSION_ATTACHMENT_VARIANT_ORIGINAL, image.original) } : {}),
	}
}
