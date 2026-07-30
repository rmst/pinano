import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import { sessionWorkspacePath } from "../paths.js"
import { sessionWorkspaceDirName } from "./workspace-names.js"

export const SESSION_ATTACHMENT_KIND_IMAGE = "image"
export const SESSION_ATTACHMENT_KIND_PENDING_IMAGE = "pending_image"
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

function reservationFilePrefix(id) {
	return `.prompt-image-${sha256Hex(Buffer.from(String(id)))}-`
}

function variantMetadata(sessionId, number, variant, source, buffer, options = {}) {
	const userInputDir = sessionUserInputDir(sessionId, options)
	const filename = promptImageAttachmentFilename(number, source.mimeType, variant)
	return {
		variant,
		storageBackend: SESSION_ATTACHMENT_STORAGE_LOCAL,
		storageKey: `${SESSION_USER_INPUT_DIRNAME}/${filename}`,
		filename,
		filePath: join(userInputDir, filename),
		mimeType: source.mimeType ?? "application/octet-stream",
		byteSize: buffer.byteLength,
		sha256: sha256Hex(buffer),
		widthPx: Number.isFinite(source.widthPx) && source.widthPx > 0 ? source.widthPx : null,
		heightPx: Number.isFinite(source.heightPx) && source.heightPx > 0 ? source.heightPx : null,
	}
}

function traceSync(diagnostics, name, args, operation) {
	const end = diagnostics?.span?.(name, args)
	try {
		const result = operation()
		end?.()
		return result
	} catch (error) {
		end?.({ failed: true, errorName: error instanceof Error ? error.name : typeof error })
		throw error
	}
}

async function traceAsync(diagnostics, name, args, operation) {
	const end = diagnostics?.span?.(name, args)
	try {
		const result = await operation()
		end?.()
		return result
	} catch (error) {
		end?.({ failed: true, errorName: error instanceof Error ? error.name : typeof error })
		throw error
	}
}

async function removePaths(paths) {
	await Promise.all([...new Set(paths.filter(Boolean))].map((path) => rm(path, { force: true })))
}

/**
 * Materialize one reserved image outside the serialized persistence worker. Each variant is written to a same-directory temporary file and atomically renamed into place.
 * @param {string} sessionId
 * @param {{ id: string, number: number }} reservation
 * @param {{ data: string, mimeType?: string, widthPx?: number, heightPx?: number, original?: { data: string, mimeType?: string, widthPx?: number, heightPx?: number } }} image
 * @param {{ sessionDir?: string, dbPath?: string, diagnostics?: any }} [options]
 */
export async function materializePromptImageAttachmentFiles(sessionId, reservation, image, options = {}) {
	const userInputDir = sessionUserInputDir(sessionId, options)
	const spanArgs = { sessionId, attachmentId: reservation.id, imageNumber: reservation.number }
	await traceAsync(options.diagnostics, "PromptImageAttachment.mkdir", spanArgs, () => mkdir(userInputDir, { recursive: true }))
	const writtenPaths = []
	const temporaryPaths = []
	const writeVariant = async (variant, source) => {
		const args = { ...spanArgs, variant }
		const buffer = traceSync(options.diagnostics, "PromptImageAttachment.decode", args, () => base64ToBuffer(source.data))
		const metadata = traceSync(options.diagnostics, "PromptImageAttachment.hash", { ...args, byteSize: buffer.byteLength }, () =>
			variantMetadata(sessionId, reservation.number, variant, source, buffer, options))
		const tempPath = join(userInputDir, `${reservationFilePrefix(reservation.id)}${variant}-${process.pid}-${randomUUID()}.tmp`)
		temporaryPaths.push(tempPath)
		await traceAsync(options.diagnostics, "PromptImageAttachment.write", { ...args, byteSize: buffer.byteLength }, () =>
			writeFile(tempPath, buffer, { flag: "wx" }))
		await traceAsync(options.diagnostics, "PromptImageAttachment.rename", args, () => rename(tempPath, metadata.filePath))
		temporaryPaths.splice(temporaryPaths.indexOf(tempPath), 1)
		writtenPaths.push(metadata.filePath)
		return metadata
	}
	try {
		const display = await writeVariant(SESSION_ATTACHMENT_VARIANT_DISPLAY, image)
		const original = image.original?.data
			? await writeVariant(SESSION_ATTACHMENT_VARIANT_ORIGINAL, image.original)
			: undefined
		return { display, ...(original ? { original } : {}) }
	} catch (error) {
		await removePaths([...temporaryPaths, ...writtenPaths])
		throw error
	}
}

/** Remove finalized files after a known pre-commit failure. */
export async function removeMaterializedPromptImageAttachmentFiles(attachments) {
	await removePaths(attachments.flatMap((attachment) => [attachment?.display?.filePath, attachment?.original?.filePath]))
}

/**
 * Remove files left by an interrupted reservation. Final names are safe to identify because a pending reservation owns its session-global number exclusively.
 * @param {{ id: string, sessionId: string, number: number }} reservation
 * @param {{ sessionDir?: string, dbPath?: string }} [options]
 */
export async function removePromptImageAttachmentReservationFiles(reservation, options = {}) {
	const userInputDir = sessionUserInputDir(reservation.sessionId, options)
	let names
	try {
		names = await readdir(userInputDir)
	} catch (error) {
		if (error?.code === "ENOENT") return
		throw error
	}
	const tempPrefix = reservationFilePrefix(reservation.id)
	const finalPrefix = `pasted-image-${paddedAttachmentNumber(reservation.number)}`
	const selected = names.filter((name) =>
		(name.startsWith(tempPrefix) && name.endsWith(".tmp"))
		|| (name.startsWith(finalPrefix) && /^(-original)?\.(png|jpg|gif|webp|bin)$/.test(name.slice(finalPrefix.length))))
	await removePaths(selected.map((name) => join(userInputDir, name)))
}

/** Load a local attachment file outside the serialized persistence worker. */
export async function readPromptImageAttachmentVariant(db, sessionId, attachmentId, variant = SESSION_ATTACHMENT_VARIANT_DISPLAY, options = {}) {
	const args = { sessionId, attachmentId, variant }
	const metadata = await traceAsync(options.diagnostics, "PromptImageAttachment.readMetadata", args, () =>
		db.getAttachmentVariantMetadata(sessionId, attachmentId, variant))
	if (!metadata?.filePath) return undefined
	try {
		const data = await traceAsync(options.diagnostics, "PromptImageAttachment.read", args, () => readFile(metadata.filePath))
		return { ...metadata, data }
	} catch (error) {
		if (error?.code === "ENOENT") return undefined
		throw error
	}
}

/**
 * Reserve numbers, materialize files outside persistence, and atomically finalize attachment metadata.
 * @param {any} db
 * @param {string} sessionId
 * @param {any[]} images
 * @param {{ minimumNumber: number, sessionDir?: string, diagnostics?: any }} options
 */
export async function persistPromptImageAttachments(db, sessionId, images, options = {}) {
	if (!Array.isArray(images) || images.length === 0) return []
	if (!Number.isInteger(options.minimumNumber) || options.minimumNumber <= 0) {
		throw new TypeError("prompt image minimum number must be a positive integer")
	}
	const spanArgs = { sessionId, imageCount: images.length }
	const end = options.diagnostics?.span?.("PromptImageAttachments.persist", spanArgs)
	let reservations = []
	const materialized = []
	let finalizeAttempted = false
	try {
		reservations = await traceAsync(options.diagnostics, "PromptImageAttachments.reserve", spanArgs, () =>
			db.reservePromptImageAttachments(sessionId, images.map((image) => ({
				id: randomUUID(),
				detail: image.detail ?? null,
			})), { minimumNumber: options.minimumNumber }))
		for (let index = 0; index < images.length; index += 1) {
			const variants = await materializePromptImageAttachmentFiles(sessionId, reservations[index], images[index], options)
			materialized.push({ ...reservations[index], variants })
		}
		finalizeAttempted = true
		const created = await traceAsync(options.diagnostics, "PromptImageAttachments.finalize", spanArgs, () =>
			db.finalizePromptImageAttachments(sessionId, materialized))
		end?.()
		return created
	} catch (error) {
		if (finalizeAttempted) {
			try {
				const existing = await Promise.all(reservations.map((reservation) => db.getImageAttachment(reservation.id)))
				if (existing.every((attachment, index) =>
					attachment?.attachmentSessionId === sessionId
					&& Number(attachment.imageNumber) === reservations[index].number)) {
					end?.({ finalizeResponseLost: true })
					return existing
				}
			} catch {
				// A failed verification leaves the files and reservations intact. Startup recovery can distinguish finalized rows from pending reservations without risking deletion after an uncertain commit.
				end?.({ failed: true, commitUncertain: true, errorName: error instanceof Error ? error.name : typeof error })
				throw error
			}
		}
		try {
			await removeMaterializedPromptImageAttachmentFiles(materialized.map((attachment) => attachment.variants))
			for (const reservation of reservations) {
				await removePromptImageAttachmentReservationFiles({ ...reservation, sessionId }, options)
			}
		} catch {
			// Keep pending rows when cleanup is incomplete, preventing their numbers from being reused over files we could not remove.
			end?.({ failed: true, cleanupFailed: true, errorName: error instanceof Error ? error.name : typeof error })
			throw error
		}
		try {
			await db.cancelPromptImageAttachmentReservations(sessionId, reservations.map((reservation) => reservation.id))
		} catch {
			// Files are gone and pending rows are invisible. Recovery will remove the rows after a transient persistence failure.
		}
		end?.({ failed: true, errorName: error instanceof Error ? error.name : typeof error })
		throw error
	}
}

/** Remove files and rows left by a process interruption between reservation and finalization. */
export async function recoverPendingPromptImageAttachments(db, options = {}) {
	const reservations = await traceAsync(options.diagnostics, "PromptImageAttachments.listPending", {}, () =>
		db.listPendingPromptImageAttachmentReservations())
	for (const reservation of reservations) {
		try {
			await traceAsync(options.diagnostics, "PromptImageAttachments.recover", {
				sessionId: reservation.sessionId,
				attachmentId: reservation.id,
				imageNumber: reservation.number,
			}, async () => {
				await removePromptImageAttachmentReservationFiles(reservation, options)
				await db.cancelPromptImageAttachmentReservations(reservation.sessionId, [reservation.id])
			})
		} catch (error) {
			options.onError?.(error, reservation)
		}
	}
	return reservations.length
}
