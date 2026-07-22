import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { dataRoot } from "./paths.js"
import { isProjectContextMessage } from "./project-context.js"
import { SESSION_CUSTOM_TYPE_FILE_RESTORE } from "./session-custom-types.js"
import { isAutomatedMaintenanceMessage } from "./session-properties.js"

const VERSION = 1
const CUSTOM_TYPE = "file_checkpoint"
const RESTORE_CUSTOM_TYPE = SESSION_CUSTOM_TYPE_FILE_RESTORE

/** @param {string} sessionId */
export function fileCheckpointDir(sessionId) {
	return join(dataRoot(), "file-checkpoints", sessionId)
}

function globalBlobDir() {
	return join(dataRoot(), "file-checkpoints", "blobs")
}

/** @param {string} hash */
function globalBlobPath(hash) {
	return join(globalBlobDir(), hash)
}

/** @param {string} sessionId @param {string} hash */
function legacyBlobPath(sessionId, hash) {
	return join(fileCheckpointDir(sessionId), "blobs", hash)
}

/** @param {string} sessionId @param {string} hash @returns {Promise<Buffer>} */
async function readCheckpointBlob(sessionId, hash) {
	try {
		return await readFile(globalBlobPath(hash))
	} catch (/** @type {any} */ err) {
		if (err?.code !== "ENOENT") throw err
	}
	try {
		return await readFile(legacyBlobPath(sessionId, hash))
	} catch (/** @type {any} */ err) {
		if (err?.code !== "ENOENT") throw err
	}
	// Older checkpoints were scoped by the session that originally captured the
	// blob. A DAG branch can inherit that checkpoint from another session, so use
	// the content hash to find a legacy blob if it has not been promoted yet.
	let sessions = []
	try {
		sessions = await readdir(join(dataRoot(), "file-checkpoints"), { withFileTypes: true })
	} catch (/** @type {any} */ err) {
		if (err?.code !== "ENOENT") throw err
	}
	for (const entry of sessions) {
		if (!entry.isDirectory() || entry.name === "blobs") continue
		try {
			return await readFile(join(dataRoot(), "file-checkpoints", entry.name, "blobs", hash))
		} catch (/** @type {any} */ err) {
			if (err?.code !== "ENOENT") throw err
		}
	}
	throw Object.assign(new Error(`Missing checkpoint blob ${hash}`), { code: "ENOENT" })
}

/** @param {Buffer} buffer */
function sha256(buffer) {
	return createHash("sha256").update(buffer).digest("hex")
}

/** @param {any} entry */
function fileCheckpointData(entry) {
	if (entry?.type !== "custom" || entry.customType !== CUSTOM_TYPE) return undefined
	const data = entry.data ?? {}
	if (data.version !== VERSION) return undefined
	if (typeof data.checkpointEntryId !== "string") return undefined
	if (typeof data.path !== "string") return undefined
	return data
}

/** @param {any} entry */
function isProjectUserEntry(entry) {
	return entry?.type === "message" && entry.message?.role === "user" && isProjectContextMessage(entry.message)
}

/**
 * The file checkpoint for a mutation is the nearest real user message on the
 * active branch. Rewinding to that user message should restore the file system
 * to the state before any Write/Edit tools in that turn ran.
 * @param {import("../session-manager/session.js").Session} session
 * @returns {string | undefined}
 */
export function currentFileCheckpointEntryId(session) {
	const branch = session.getBranch()
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]
		if (entry.type === "message" && entry.message?.role === "user" && !isProjectUserEntry(entry) && !isAutomatedMaintenanceMessage(entry.message)) return entry.id
	}
	return undefined
}

/**
 * @param {import("../session-manager/session.js").Session} session
 * @param {string} checkpointEntryId
 * @param {string} absolutePath
 */
function alreadyCaptured(session, checkpointEntryId, absolutePath) {
	return session.getBranch().some((entry) => {
		const data = fileCheckpointData(entry)
		return data?.checkpointEntryId === checkpointEntryId && data.path === absolutePath
	})
}

/**
 * Persist a preimage for a file about to be mutated by a Pinano file-editing
 * tool. The first mutation of a path within a checkpoint wins; later edits in
 * the same turn reuse that original preimage.
 * @param {import("../session-manager/session.js").Session | null | undefined} session
 * @param {string} filePath
 * @returns {Promise<{ recorded: boolean, checkpointEntryId?: string, reason?: string }>}
 */
export async function recordFileCheckpoint(session, filePath) {
	if (!session) return { recorded: false, reason: "no_session" }
	const checkpointEntryId = currentFileCheckpointEntryId(session)
	if (!checkpointEntryId) return { recorded: false, reason: "no_checkpoint_entry" }
	const sessionId = session.getMetadata()?.id
	if (!sessionId) return { recorded: false, reason: "no_session_id" }
	const absolutePath = resolve(filePath)
	if (alreadyCaptured(session, checkpointEntryId, absolutePath)) return { recorded: false, checkpointEntryId, reason: "already_captured" }

	let existed = false
	let hash = null
	let size = 0
	try {
		const info = await stat(absolutePath)
		if (!info.isFile()) throw new Error(`Cannot checkpoint non-file path before edit: ${absolutePath}`)
		const content = await readFile(absolutePath)
		existed = true
		hash = sha256(content)
		size = content.byteLength
		await mkdir(dirname(globalBlobPath(hash)), { recursive: true })
		try {
			await writeFile(globalBlobPath(hash), content, { flag: "wx" })
		} catch (/** @type {any} */ err) {
			if (err?.code !== "EEXIST") throw err
		}
	} catch (/** @type {any} */ err) {
		if (err?.code !== "ENOENT") throw err
	}

	await session.appendCustomEntry(CUSTOM_TYPE, {
		version: VERSION,
		checkpointEntryId,
		path: absolutePath,
		existed,
		hash,
		size,
		createdAt: new Date().toISOString(),
	})
	return { recorded: true, checkpointEntryId }
}

/**
 * Return the file checkpoints on the current branch that would be used when
 * restoring to `checkpointEntryId`: the first preimage for each path in the
 * discarded tail.
 * @param {import("../session-manager/session.js").Session} session
 * @param {string} checkpointEntryId
 */
export function fileCheckpointsForRestore(session, checkpointEntryId) {
	const branch = session.getBranch()
	const start = branch.findIndex((entry) => entry.id === checkpointEntryId)
	if (start < 0) return []
	const byPath = new Map()
	for (const entry of branch.slice(start)) {
		const data = fileCheckpointData(entry)
		if (!data || byPath.has(data.path)) continue
		byPath.set(data.path, { entryId: entry.id, data })
	}
	return [...byPath.values()]
}

/**
 * Hard-restore files to their preimage at `checkpointEntryId`. Created files
 * are deleted; existing files are overwritten with their captured bytes. This
 * deliberately does not try to merge or conflict-detect manual edits: rewind is
 * a local undo operation.
 * @param {import("../session-manager/session.js").Session} session
 * @param {string} checkpointEntryId
 */
export async function restoreFilesToCheckpoint(session, checkpointEntryId) {
	const sessionId = session.getMetadata()?.id
	if (!sessionId) throw new Error("Cannot restore file checkpoints for a session without an id")
	const checkpoints = fileCheckpointsForRestore(session, checkpointEntryId)
	const restored = []
	for (const { data } of checkpoints) {
		if (data.existed) {
			if (!data.hash) throw new Error(`Missing checkpoint blob hash for ${data.path}`)
			const content = await readCheckpointBlob(sessionId, data.hash)
			await mkdir(dirname(data.path), { recursive: true })
			await writeFile(data.path, content)
		} else {
			await rm(data.path, { force: true })
		}
		restored.push({ path: data.path, existed: data.existed, hash: data.hash, size: data.size })
	}
	return { restored }
}

/**
 * @param {import("../session-manager/session.js").Session} session
 * @param {string} checkpointEntryId
 * @param {{ restored: Array<{ path: string, existed: boolean, hash?: string | null, size?: number }> }} result
 */
export async function appendFileRestoreEntry(session, checkpointEntryId, result) {
	return session.appendCustomEntry(RESTORE_CUSTOM_TYPE, {
		version: VERSION,
		checkpointEntryId,
		restored: result.restored,
		createdAt: new Date().toISOString(),
	})
}

/** @param {string} sessionId */
export async function deleteFileCheckpoints(sessionId) {
	await rm(fileCheckpointDir(sessionId), { recursive: true, force: true })
}
