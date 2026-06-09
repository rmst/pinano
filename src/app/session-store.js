// App-level session integration. SQLite is the canonical transcript/tree and
// metadata store.

import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"

import { Session, SqliteSessionStorage } from "../session-manager/index.js"
import { serverDbPath, sessionWorkspacePath } from "./paths.js"
import { isProjectContextMessage } from "./project-context.js"
import { openServerDb } from "./server-db.js"
import { sessionActivityAt } from "./session-activity.js"
import { deleteFileCheckpoints } from "./file-checkpoints.js"
import { ensureSessionWorkspace } from "./session-workspaces.js"
import { sessionWorkspaceDirName } from "./session-workspace-names.js"

/** @typedef {import("../session-manager/types.js").SessionEntry} SessionEntry */
/** @typedef {import("./server-db.js").ServerDb} ServerDb */

/** @type {{ path: string, db: ServerDb } | undefined} */
let metadataDb

/** @returns {Promise<ServerDb>} */
async function getMetadataDb() {
	const path = serverDbPath()
	if (!metadataDb || metadataDb.path !== path) {
		try { metadataDb?.db.close() } catch {}
		const db = openServerDb()
		try {
			assertNoSessionWorkspaceNameCollisions(db)
		} catch (err) {
			db.close()
			throw err
		}
		metadataDb = { path, db }
	}
	return metadataDb.db
}

/** @param {ServerDb} db */
function assertNoSessionWorkspaceNameCollisions(db) {
	const byWorkspaceName = new Map()
	for (const session of db.listSessions()) {
		const workspaceName = sessionWorkspaceDirName(session.id)
		const existing = byWorkspaceName.get(workspaceName)
		if (existing && existing !== session.id) {
			throw new Error(`Cannot use shortened Pinano session workspace paths: active sessions ${existing} and ${session.id} both map to workspace dir ${workspaceName}`)
		}
		byWorkspaceName.set(workspaceName, session.id)
	}
}

/** @param {ServerDb} db @param {string} id */
function sessionWorkspaceNameUsedByActiveSession(db, id) {
	const workspaceName = sessionWorkspaceDirName(id)
	return db.listSessions().some((session) => session.id !== id && sessionWorkspaceDirName(session.id) === workspaceName)
}

/** @param {string} path */
async function pathExists(path) {
	try {
		await lstat(path)
		return true
	} catch (/** @type {any} */ err) {
		if (err?.code === "ENOENT") return false
		throw err
	}
}

/** @param {ServerDb} db @param {string} id */
async function sessionWorkspaceNameAvailable(db, id) {
	if (sessionWorkspaceNameUsedByActiveSession(db, id)) return false
	return !await pathExists(sessionWorkspacePath(id))
}

/** @param {ServerDb} db */
async function generateSessionId(db) {
	for (let i = 0; i < 200; i++) {
		const id = randomUUID()
		if (await sessionWorkspaceNameAvailable(db, id)) return id
	}
	throw new Error("Could not allocate a Pinano session id with an unused workspace path")
}

/** @returns {Promise<string>} */
export async function createSessionId() {
	return generateSessionId(await getMetadataDb())
}

/** Ensure the SQLite session store has been opened and migrated for this home. */
export async function ensureSessionStoreMigrated() {
	await getMetadataDb()
}

/**
 * @typedef {object} SessionListEntry
 * @property {string} id
 * @property {string} cwd
 * @property {string} updatedAt
 */

/**
 * @typedef {object} SessionPreviewMessage
 * @property {string} timestamp
 * @property {string} text
 * @property {string} role
 */

/**
 * @typedef {object} SessionPreview
 * @property {SessionPreviewMessage} [first]
 * @property {SessionPreviewMessage} [lastUser]
 */

/**
 * @param {unknown} content
 * @returns {string}
 */
function flattenMessageContent(content) {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return /** @type {any[]} */ (content)
		.filter((/** @type {any} */ c) => c?.type === "text")
		.map((/** @type {any} */ c) => c.text)
		.join(" ")
}

/**
 * Pull out the first message and the most recent user message for pickers.
 * The synthetic project-context message is filtered out.
 *
 * @param {Array<{ previewKind: "first" | "lastUser", timestamp: string, role: string, content: string | any[] }>} messages
 * @returns {SessionPreview}
 */
export function sessionPreviewFromMessages(messages) {
	messages = messages
		.filter((/** @type {any} */ e) => !isProjectContextMessage(e))
	const firstEntry = messages.find((/** @type {any} */ e) => e.previewKind === "first")
	const lastUserEntry = messages.find((/** @type {any} */ e) => e.previewKind === "lastUser")
	/** @type {SessionPreview} */
	const preview = {}
	if (firstEntry) {
		preview.first = {
			timestamp: firstEntry.timestamp,
			text: flattenMessageContent(firstEntry.content).trim(),
			role: firstEntry.role ?? "?",
		}
	}
	if (lastUserEntry) {
		preview.lastUser = {
			timestamp: lastUserEntry.timestamp,
			text: flattenMessageContent(lastUserEntry.content).trim(),
			role: "user",
		}
	}
	return preview
}

/**
 * Pull out the first message and the most recent user message for pickers.
 * The synthetic project-context message is filtered out.
 *
 * @param {string} id
 * @returns {Promise<SessionPreview>}
 */
export async function loadSessionPreview(id) {
	const db = await getMetadataDb()
	return sessionPreviewFromMessages(db.loadSessionPreviewMessages(id))
}

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, SessionPreview>>}
 */
export async function loadSessionPreviews(ids) {
	const db = await getMetadataDb()
	/** @type {Map<string, Array<{ previewKind: "first" | "lastUser", timestamp: string, role: string, content: string | any[] }>>} */
	const messagesBySessionId = new Map()
	for (const row of db.loadSessionPreviewMessagesForSessions(ids)) {
		const messages = messagesBySessionId.get(row.sessionId) ?? []
		messages.push(row)
		messagesBySessionId.set(row.sessionId, messages)
	}
	return new Map(ids.map((id) => [id, sessionPreviewFromMessages(messagesBySessionId.get(id) ?? [])]))
}

/** List sessions, newest first. Optionally filter to a cwd.
 * @param {string} [filterCwd]
 * @returns {Promise<SessionListEntry[]>} */
export async function listSessions(filterCwd) {
	const db = await getMetadataDb()
	return db.listSessions(filterCwd).map((entry) => ({
		id: entry.id,
		cwd: entry.cwd,
		updatedAt: entry.updatedAt,
	}))
}

/**
 * @param {string} cwd
 * @returns {Promise<{ session: Session, id: string }>}
 */
export async function createSession(cwd) {
	const db = await getMetadataDb()
	const id = await generateSessionId(db)
	const storage = SqliteSessionStorage.create(db.raw, { cwd, sessionId: id })
	await ensureSessionWorkspace(id)
	return { session: new Session(storage), id }
}

/**
 * Create a new session that shares the source session's active branch prefix.
 * Conversation entries are immutable global DAG nodes, so this records new
 * session membership refs without duplicating message payload rows.
 * @param {string} sourceId
 * @param {{ cwd?: string, sessionId?: string, sourceEntryId?: string | null }} [options]
 * @returns {Promise<{ session: Session, id: string, sourceId: string }>}
 */
export async function branchSession(sourceId, options = {}) {
	const db = await getMetadataDb()
	const id = options.sessionId ?? await generateSessionId(db)
	const storage = SqliteSessionStorage.branchFrom(db.raw, sourceId, {
		sessionId: id,
		cwd: options.cwd,
		...(Object.prototype.hasOwnProperty.call(options, "sourceEntryId") ? { sourceEntryId: options.sourceEntryId } : {}),
	})
	await ensureSessionWorkspace(id)
	const session = new Session(storage)
	return { session, id, sourceId }
}

/**
 * @param {string} id
 * @returns {Promise<{ session: Session, id: string }>}
 */
export async function openSession(id) {
	const db = await getMetadataDb()
	const storage = SqliteSessionStorage.open(db.raw, id)
	const session = new Session(storage)
	const meta = storage.getMetadata()
	db.upsertSession({
		id,
		cwd: meta.cwd,
		createdAt: meta.createdAt,
		updatedAt: sessionActivityAt(session),
	})
	return { session, id }
}


/** Refresh updatedAt from the latest persisted user/assistant message.
 * @param {string} id
 * @returns {Promise<void>} */
export async function touchSession(id) {
	const { session } = await openSession(id)
	const db = await getMetadataDb()
	db.touchSession(id, undefined, sessionActivityAt(session))
}

/**
 * Returns true if the session has zero real user/assistant/tool messages.
 * The synthetic project-context message does not count as activity.
 *
 * @param {{ getEntries: () => any[] }} session
 * @returns {boolean}
 */
export function sessionIsEmpty(session) {
	return !session.getEntries().some((/** @type {any} */ e) => {
		if (e.type !== "message") return false
		if (isProjectContextMessage(e.message)) return false
		return true
	})
}

/** Forget a session (used by explicit deletion).
 * @param {string} id
 * @returns {Promise<void>} */
export async function deleteSession(id) {
	await deleteFileCheckpoints(id)
	const db = await getMetadataDb()
	db.markSessionDeleted(id)
}
