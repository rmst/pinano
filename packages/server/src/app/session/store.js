// App-level session integration. The service uses the async persistence contract; standalone helpers retain the synchronous SQLite adapter.

import { randomUUID } from "node:crypto"
import { lstat } from "node:fs/promises"

import { PersistenceSessionStorage, Session, SqliteSessionStorage } from "../../session-manager/index.js"
import { loadTranscriptMessages } from "../../session-manager/storage-sqlite.js"
import { serverDbPath, sessionWorkspacePath } from "../paths.js"
import { isProjectContextMessage } from "../project/context.js"
import { openServerDb } from "../database/index.js"
import { sessionActivityAt } from "./activity.js"
import { ensureSessionWorkspace } from "./workspaces.js"
import { sessionWorkspaceDirName } from "./workspace-names.js"

/** @typedef {import("../../session-manager/types.js").SessionEntry} SessionEntry */
/** @typedef {import("../database/index.js").ServerDb} ServerDb */
/** @typedef {import("../../persistence/server-contract.js").ServerPersistence} ServerPersistence */
/** @typedef {ServerDb | ServerPersistence} ServerPersistenceHandle */
/** @typedef {{ enabled?: boolean, span?: (name: string, args?: Record<string, any>) => (extraArgs?: Record<string, any>) => void }} StorageDiagnostics */

/** @type {{ path: string, db: ServerDb } | undefined} */
let metadataDb
let metadataDbPromise
let metadataDbPromisePath

/** @returns {Promise<ServerDb>} */
async function getMetadataDb() {
	const path = serverDbPath()
	if (metadataDb?.path === path) return metadataDb.db
	if (metadataDbPromise && metadataDbPromisePath === path) return metadataDbPromise
	const previous = metadataDbPromise?.catch(() => undefined)
	const opening = (async () => {
		await previous
		if (metadataDb?.path === path) return metadataDb.db
		try { await metadataDb?.db.close() } catch {}
		metadataDb = undefined
		const db = openServerDb({ path })
		try {
			await assertNoSessionWorkspaceNameCollisions(db)
		} catch (err) {
			await db.close()
			throw err
		}
		metadataDb = { path, db }
		return db
	})()
	metadataDbPromise = opening
	metadataDbPromisePath = path
	try {
		return await opening
	} finally {
		if (metadataDbPromise === opening) {
			metadataDbPromise = undefined
			metadataDbPromisePath = undefined
		}
	}
}

/** @param {ServerPersistenceHandle} db */
export async function assertNoSessionWorkspaceNameCollisions(db) {
	const byWorkspaceName = new Map()
	for (const session of await db.listSessionStatuses({ includeHidden: true })) {
		const workspaceName = sessionWorkspaceDirName(session.id)
		const existing = byWorkspaceName.get(workspaceName)
		if (existing && existing !== session.id) {
			throw new Error(`Cannot use shortened Cerex session workspace paths: active sessions ${existing} and ${session.id} both map to workspace dir ${workspaceName}`)
		}
		byWorkspaceName.set(workspaceName, session.id)
	}
}

/** @param {ServerPersistenceHandle} db @param {string} id */
async function sessionWorkspaceNameUsedByActiveSession(db, id) {
	const workspaceName = sessionWorkspaceDirName(id)
	return (await db.listSessionStatuses({ includeHidden: true })).some((session) => session.id !== id && sessionWorkspaceDirName(session.id) === workspaceName)
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

/** @param {ServerPersistenceHandle} db @param {string} id */
async function sessionWorkspaceNameAvailable(db, id) {
	if (await sessionWorkspaceNameUsedByActiveSession(db, id)) return false
	return !await pathExists(sessionWorkspacePath(id))
}

/** @param {ServerPersistenceHandle} db */
async function generateSessionId(db) {
	for (let i = 0; i < 200; i++) {
		const id = randomUUID()
		if (await sessionWorkspaceNameAvailable(db, id)) return id
	}
	throw new Error("Could not allocate a Cerex session id with an unused workspace path")
}

/** @returns {Promise<string>} */
export async function createSessionId() {
	return createSessionIdInDb(await getMetadataDb())
}

/** @param {ServerPersistenceHandle} db @returns {Promise<string>} */
export async function createSessionIdInDb(db) {
	return generateSessionId(db)
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
	return await loadSessionPreviewInDb(await getMetadataDb(), id)
}

/**
 * @param {ServerPersistenceHandle} db
 * @param {string} id
 * @returns {Promise<SessionPreview>}
 */
export async function loadSessionPreviewInDb(db, id) {
	return sessionPreviewFromMessages(await db.loadSessionPreviewMessages(id))
}

/**
 * @param {string[]} ids
 * @returns {Promise<Map<string, SessionPreview>>}
 */
export async function loadSessionPreviews(ids) {
	return await loadSessionPreviewsInDb(await getMetadataDb(), ids)
}

/**
 * @param {ServerPersistenceHandle} db
 * @param {string[]} ids
 * @returns {Promise<Map<string, SessionPreview>>}
 */
export async function loadSessionPreviewsInDb(db, ids) {
	/** @type {Map<string, Array<{ previewKind: "first" | "lastUser", timestamp: string, role: string, content: string | any[] }>>} */
	const messagesBySessionId = new Map()
	for (const row of await db.loadSessionPreviewMessagesForSessions(ids)) {
		const messages = messagesBySessionId.get(row.sessionId) ?? []
		messages.push(row)
		messagesBySessionId.set(row.sessionId, messages)
	}
	return new Map(ids.map((id) => [id, sessionPreviewFromMessages(messagesBySessionId.get(id) ?? [])]))
}

/** Load selected transcript payloads through either the async persistence contract or the standalone synchronous SQLite adapter. */
export async function loadTranscriptMessagesInDb(db, sessionId, entryIds) {
	if (db.raw) return loadTranscriptMessages(db.raw, sessionId, entryIds)
	return await db.loadTranscriptMessages(sessionId, entryIds)
}

/** List sessions, newest first. Optionally filter to a cwd.
 * @param {string} [filterCwd]
 * @returns {Promise<SessionListEntry[]>} */
export async function listSessions(filterCwd) {
	const db = await getMetadataDb()
	return (await db.listSessionStatuses())
		.filter((entry) => !filterCwd || entry.cwd === filterCwd)
		.map((entry) => ({
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
	return createSessionInDb(await getMetadataDb(), cwd)
}

/**
 * Create a session against an already-owned persistence handle.
 * @param {ServerPersistenceHandle} db
 * @param {string} cwd
 * @param {{ diagnostics?: StorageDiagnostics }} [context]
 * @returns {Promise<{ session: Session, id: string }>}
 */
export async function createSessionInDb(db, cwd, context = {}) {
	const id = await generateSessionId(db)
	const storage = db.raw
		? SqliteSessionStorage.create(db.raw, { cwd, sessionId: id, diagnostics: context.diagnostics })
		: new PersistenceSessionStorage(db, await db.createSessionStorage({ cwd, sessionId: id }))
	await ensureSessionWorkspace(id)
	return { session: new Session(storage), id }
}

/**
 * Create a new session that shares the source session's active branch prefix.
 * Conversation payloads are immutable global rows, so this copies only the
 * compact session-local branch rows without duplicating heavyweight payloads.
 * @param {string} sourceId
 * @param {{ cwd?: string, sessionId?: string, sourceEntryId?: string | null }} [options]
 * @returns {Promise<{ session: Session, id: string, sourceId: string }>}
 */
export async function branchSession(sourceId, options = {}) {
	return branchSessionInDb(await getMetadataDb(), sourceId, options)
}

/**
 * Create a branch against an already-owned persistence handle.
 * @param {ServerPersistenceHandle} db
 * @param {string} sourceId
 * @param {{ cwd?: string, sessionId?: string, sourceEntryId?: string | null }} [options]
 * @param {{ diagnostics?: StorageDiagnostics }} [context]
 * @returns {Promise<{ session: Session, id: string, sourceId: string }>}
 */
export async function branchSessionInDb(db, sourceId, options = {}, context = {}) {
	const id = options.sessionId ?? await generateSessionId(db)
	const storageOptions = {
		sessionId: id,
		cwd: options.cwd,
		...(Object.prototype.hasOwnProperty.call(options, "sourceEntryId") ? { sourceEntryId: options.sourceEntryId } : {}),
	}
	const storage = db.raw
		? SqliteSessionStorage.branchFrom(db.raw, sourceId, { ...storageOptions, diagnostics: context.diagnostics })
		: new PersistenceSessionStorage(db, await db.branchSessionStorage(sourceId, storageOptions))
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
	const opened = await openSessionInDb(db, id)
	const meta = opened.session.getMetadata()
	await db.upsertSession({
		id,
		cwd: meta.cwd,
		createdAt: meta.createdAt,
		updatedAt: sessionActivityAt(opened.session),
	})
	return opened
}

/**
 * Open a session against an already-owned persistence handle. This intentionally
 * does not touch the session row; callers that own the boundary should decide
 * whether a metadata refresh is needed.
 * @param {ServerPersistenceHandle} db
 * @param {string} id
 * @param {{ diagnostics?: StorageDiagnostics }} [context]
 * @returns {{ session: Session, id: string } | Promise<{ session: Session, id: string }>}
 */
export function openSessionInDb(db, id, context = {}) {
	if (db.raw) return { session: new Session(SqliteSessionStorage.open(db.raw, id, { diagnostics: context.diagnostics })), id }
	return db.openSessionStorage(id)
		.then((snapshot) => ({ session: new Session(new PersistenceSessionStorage(db, snapshot)), id }))
}

/** Open only the canonical compact session rows used for transcript-first reads. */
export function openSessionManifestInDb(db, id, context = {}) {
	if (db.raw) return { session: new Session(SqliteSessionStorage.openManifest(db.raw, id, { diagnostics: context.diagnostics })), id }
	return db.openSessionManifestStorage(id)
		.then((snapshot) => ({ session: new Session(new PersistenceSessionStorage(db, snapshot)), id }))
}

/** Refresh updatedAt from the latest persisted user/assistant message.
 * @param {string} id
 * @returns {Promise<void>} */
export async function touchSession(id) {
	const db = await getMetadataDb()
	const { session } = await openSessionInDb(db, id)
	await db.touchSession(id, undefined, sessionActivityAt(session))
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

/** Soft-delete a session.
 * @param {string} id
 * @returns {Promise<void>} */
export async function deleteSession(id) {
	const db = await getMetadataDb()
	await db.markSessionDeleted(id)
}

/**
 * Restore a soft-deleted session.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function restoreSession(id) {
	return restoreSessionInDb(await getMetadataDb(), id)
}

/**
 * Restore a soft-deleted session against an already-owned persistence handle.
 * @param {ServerPersistenceHandle} db
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function restoreSessionInDb(db, id) {
	if (await sessionWorkspaceNameUsedByActiveSession(db, id)) {
		throw new Error(`Cannot restore Cerex session ${id}: active session already maps to workspace dir ${sessionWorkspaceDirName(id)}`)
	}
	return await db.restoreSession(id)
}
