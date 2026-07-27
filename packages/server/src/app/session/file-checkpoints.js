import { createHash } from "node:crypto"
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { dataRoot, sessionWorkspacePath } from "../paths.js"
import { isProjectContextMessage } from "../project/context.js"
import { pathIsWithin } from "../sandbox/paths.js"
import { captureLocalWorkspaceFile, restoreLocalWorkspaceFile } from "../workspace/local-files.js"
import { SESSION_CUSTOM_TYPE_FILE_RESTORE } from "./custom-types.js"
import { isAutomatedMaintenanceMessage } from "./properties.js"

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
 * @param {import("../../session-manager/session.js").Session} session
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
 * @param {import("../../session-manager/session.js").Session} session
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
 * Persist a preimage for a file about to be mutated by a Cerex file-editing
 * tool. The first mutation of a path within a checkpoint wins; later edits in
 * the same turn reuse that original preimage.
 * @param {import("../../session-manager/session.js").Session | null | undefined} session
 * @param {string} filePath
 * @param {import("../workspace/client.js").WorkspaceClient} [workspace]
 * @returns {Promise<{ recorded: boolean, checkpointEntryId?: string, reason?: string }>}
 */
export async function recordFileCheckpoint(session, filePath, workspace = undefined) {
	if (!session) return { recorded: false, reason: "no_session" }
	const checkpointEntryId = currentFileCheckpointEntryId(session)
	if (!checkpointEntryId) return { recorded: false, reason: "no_checkpoint_entry" }
	const sessionId = session.getMetadata()?.id
	if (!sessionId) return { recorded: false, reason: "no_session_id" }
	const requestedPath = resolve(filePath)
	if (alreadyCaptured(session, checkpointEntryId, requestedPath)) return { recorded: false, checkpointEntryId, reason: "already_captured" }

	const sessionDir = sessionWorkspacePath(sessionId)
	const sessionOwned = pathIsWithin(sessionDir, requestedPath)
	const snapshot = sessionOwned
		? await captureLocalWorkspaceFile(requestedPath, { root: sessionDir })
		: workspace
			? await workspace.checkpoints.captureFile(requestedPath)
			: await captureLocalWorkspaceFile(requestedPath)
	const absolutePath = snapshot.path
	if (absolutePath !== requestedPath && alreadyCaptured(session, checkpointEntryId, absolutePath)) {
		return { recorded: false, checkpointEntryId, reason: "already_captured" }
	}
	const existed = snapshot.existed
	let hash = null
	const size = snapshot.size
	if (existed) {
		const content = Buffer.from(snapshot.content, "base64")
		hash = sha256(content)
		await mkdir(dirname(globalBlobPath(hash)), { recursive: true })
		try {
			await writeFile(globalBlobPath(hash), content, { flag: "wx" })
		} catch (/** @type {any} */ err) {
			if (err?.code !== "EEXIST") throw err
		}
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
 * @param {import("../../session-manager/session.js").Session} session
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
 * @param {import("../../session-manager/session.js").Session} session
 * @param {string} checkpointEntryId
 * @param {import("../workspace/client.js").WorkspaceClient} [workspace]
 */
export async function restoreFilesToCheckpoint(session, checkpointEntryId, workspace = undefined) {
	const sessionId = session.getMetadata()?.id
	if (!sessionId) throw new Error("Cannot restore file checkpoints for a session without an id")
	const checkpoints = fileCheckpointsForRestore(session, checkpointEntryId)
	const sessionDir = sessionWorkspacePath(sessionId)
	const restored = []
	for (const { data } of checkpoints) {
		const sessionOwned = pathIsWithin(sessionDir, resolve(data.path))
		if (data.existed) {
			if (!data.hash) throw new Error(`Missing checkpoint blob hash for ${data.path}`)
			const content = await readCheckpointBlob(sessionId, data.hash)
			const snapshot = { path: data.path, existed: true, content: content.toString("base64") }
			if (sessionOwned) await restoreLocalWorkspaceFile(snapshot, { root: sessionDir })
			else if (workspace) await workspace.checkpoints.restoreFile(snapshot)
			else await restoreLocalWorkspaceFile(snapshot)
		} else {
			const snapshot = { path: data.path, existed: false, content: null }
			if (sessionOwned) await restoreLocalWorkspaceFile(snapshot, { root: sessionDir })
			else if (workspace) await workspace.checkpoints.restoreFile(snapshot)
			else await restoreLocalWorkspaceFile(snapshot)
		}
		restored.push({ path: data.path, existed: data.existed, hash: data.hash, size: data.size })
	}
	return { restored }
}

/**
 * @param {import("../../session-manager/session.js").Session} session
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
