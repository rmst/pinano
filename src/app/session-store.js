// App-level session integration. SQLite is the canonical transcript/tree and
// metadata store.

import { randomUUID } from "node:crypto"

import { Session, SqliteSessionStorage } from "../session-manager/index.js"
import { serverDbPath } from "./paths.js"
import { PROJECT_CONTEXT_HEADING, isProjectContextMessage } from "./project-context.js"
import { openServerDb } from "./server-db.js"
import { sessionActivityAt } from "./session-activity.js"
import { deleteFileCheckpoints } from "./file-checkpoints.js"

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
		metadataDb = { path, db }
	}
	return metadataDb.db
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
		.filter((/** @type {any} */ e) => !isProjectContextMessage({ role: e.role, content: e.content }))
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
	return sessionPreviewFromMessages(db.loadSessionPreviewMessages(id, PROJECT_CONTEXT_HEADING))
}

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, SessionPreview>>}
 */
export async function loadSessionPreviews(ids) {
	const db = await getMetadataDb()
	/** @type {Map<string, Array<{ previewKind: "first" | "lastUser", timestamp: string, role: string, content: string | any[] }>>} */
	const messagesBySessionId = new Map()
	for (const row of db.loadSessionPreviewMessagesForSessions(ids, PROJECT_CONTEXT_HEADING)) {
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
	const id = randomUUID()
	const db = await getMetadataDb()
	const storage = SqliteSessionStorage.create(db.raw, { cwd, sessionId: id })
	return { session: new Session(storage), id }
}

/**
 * Create a new session that shares the source session's active branch prefix.
 * Conversation entries are immutable global DAG nodes, so this records new
 * session membership refs without duplicating message payload rows.
 * @param {string} sourceId
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ session: Session, id: string, sourceId: string }>}
 */
export async function branchSession(sourceId, options = {}) {
	const id = randomUUID()
	const db = await getMetadataDb()
	const storage = SqliteSessionStorage.branchFrom(db.raw, sourceId, { sessionId: id, cwd: options.cwd })
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
