// App-level session integration. Owns the on-disk session file plus a
// per-cwd index that tracks the most recently used session for that
// working directory (used by `--auto-resume` and `/resume`).

import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, writeFile, stat, rm } from "node:fs/promises"
import { dirname, join, resolve as resolvePath } from "node:path"

import { JsonlSessionStorage, Session } from "../session-manager/index.js"
import { sessionIndexPath, sessionsDir } from "./paths.js"
import { isProjectContextMessage } from "./project-context.js"

/** @typedef {import("../session-manager/types.js").SessionEntry} SessionEntry */

/**
 * @typedef {object} IndexFile
 * @property {Record<string, string>} cwds cwd → most recent sessionId
 * @property {Record<string, { cwd: string, updatedAt: string, name?: string }>} sessions
 */

/** @returns {Promise<IndexFile>} */
async function readIndex() {
	try {
		return /** @type {IndexFile} */ (JSON.parse(await readFile(sessionIndexPath(), "utf-8")))
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return { cwds: {}, sessions: {} }
		throw err
	}
}

/**
 * @param {IndexFile} idx
 * @returns {Promise<void>}
 */
async function writeIndex(idx) {
	const path = sessionIndexPath()
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, JSON.stringify(idx, null, 2))
}

/**
 * @param {string} id
 * @returns {string}
 */
function sessionPathFor(id) {
	return join(sessionsDir(), `${id}.jsonl`)
}

/** Promote `cwd → sessionId` in the index, refresh updatedAt.
 * @param {string} id
 * @param {string} cwd
 * @param {string} [name]
 * @returns {Promise<void>} */
async function touchIndex(id, cwd, name) {
	const idx = await readIndex()
	idx.cwds[cwd] = id
	idx.sessions[id] = {
		cwd,
		updatedAt: new Date().toISOString(),
		name: name ?? idx.sessions[id]?.name,
	}
	await writeIndex(idx)
}

/**
 * @typedef {object} SessionListEntry
 * @property {string} id
 * @property {string} cwd
 * @property {string} updatedAt
 * @property {string} [name]
 * @property {string} path
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
 * Peek into a session file and pull out the first message + the most recent
 * user message. The synthetic AGENTS.md/CLAUDE.md user message that pinano
 * injects at session creation is filtered out — it isn't useful context for
 * picking a session. Returns an empty object on read failure (corrupt file,
 * missing, etc.) so callers can still render the row.
 *
 * @param {string} path
 * @returns {Promise<SessionPreview>}
 */
export async function loadSessionPreview(path) {
	let storage
	try {
		storage = await JsonlSessionStorage.open(path)
	} catch {
		return {}
	}
	const messages = storage
		.getEntries()
		.filter((/** @type {any} */ e) => e.type === "message" && !isProjectContextMessage(e.message))
	const firstEntry = messages[0]
	/** @type {any} */
	let lastUserEntry
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].message?.role === "user") {
			lastUserEntry = messages[i]
			break
		}
	}
	/** @type {SessionPreview} */
	const preview = {}
	if (firstEntry) {
		preview.first = {
			timestamp: firstEntry.timestamp,
			text: flattenMessageContent(firstEntry.message?.content).trim(),
			role: firstEntry.message?.role ?? "?",
		}
	}
	if (lastUserEntry) {
		preview.lastUser = {
			timestamp: lastUserEntry.timestamp,
			text: flattenMessageContent(lastUserEntry.message?.content).trim(),
			role: "user",
		}
	}
	return preview
}

/** List sessions, newest first. Optionally filter to a cwd.
 * @param {string} [filterCwd]
 * @returns {Promise<SessionListEntry[]>} */
export async function listSessions(filterCwd) {
	const idx = await readIndex()
	/** @type {SessionListEntry[]} */
	const out = []
	for (const [id, info] of Object.entries(idx.sessions)) {
		if (filterCwd && info.cwd !== filterCwd) continue
		out.push({ id, ...info, path: sessionPathFor(id) })
	}
	out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
	return out
}

/** Open the most-recent session for `cwd` if any, else undefined.
 * @param {string} cwd
 * @returns {Promise<string | undefined>} */
export async function getLatestForCwd(cwd) {
	const idx = await readIndex()
	const id = idx.cwds[cwd]
	if (!id) return undefined
	// Guard against an entry pointing at a file we deleted.
	try {
		await stat(sessionPathFor(id))
		return id
	} catch {
		return undefined
	}
}

/**
 * @param {string} cwd
 * @returns {Promise<{ session: Session, id: string }>}
 */
export async function createSession(cwd) {
	const id = randomUUID()
	const path = sessionPathFor(id)
	const storage = await JsonlSessionStorage.create(path, { cwd, sessionId: id })
	await touchIndex(id, cwd)
	return { session: new Session(storage), id }
}

/**
 * @param {string} id
 * @returns {Promise<{ session: Session, id: string }>}
 */
export async function openSession(id) {
	const path = sessionPathFor(id)
	const storage = await JsonlSessionStorage.open(path)
	const meta = storage.getMetadata()
	await touchIndex(id, meta.cwd, undefined)
	return { session: new Session(storage), id }
}

/**
 * @typedef {object} ResolvedSession
 * @property {Session} session
 * @property {string} id
 * @property {string} cwd
 * @property {string} path
 */

/**
 * Open a session at an arbitrary on-disk path. Used by `--session <path>` to
 * load files that may live outside `sessionsDir()` (e.g. shared from another
 * machine). The session's id and cwd are read from its metadata; if the file
 * is already in `sessionsDir()` the index is touched too.
 *
 * @param {string} path
 * @returns {Promise<ResolvedSession>}
 */
export async function openSessionByPath(path) {
	const storage = await JsonlSessionStorage.open(path)
	const meta = storage.getMetadata()
	const id = meta.id
	const resolvedPath = storage.filePath
	if (resolvedPath === sessionPathFor(id)) {
		await touchIndex(id, meta.cwd, undefined)
	}
	return { session: new Session(storage), id, cwd: meta.cwd, path: resolvedPath }
}

/**
 * Resolve a `--session <path|id>` argument:
 *   - looks like a path (contains a separator or ends in `.jsonl`) → open it directly
 *   - otherwise treated as a session-id prefix → unique match in the index wins
 *
 * Throws if the argument doesn't resolve to a single session.
 *
 * @param {string} arg
 * @returns {Promise<ResolvedSession>}
 */
export async function resolveSessionArg(arg) {
	if (arg.includes("/") || arg.includes("\\") || arg.endsWith(".jsonl")) {
		return openSessionByPath(arg)
	}
	const idx = await readIndex()
	const matches = Object.keys(idx.sessions).filter((id) => id.startsWith(arg))
	if (matches.length === 0) throw new Error(`no session matches "${arg}"`)
	if (matches.length > 1) {
		const sample = matches.slice(0, 5).map((id) => id.slice(0, 8)).join(", ")
		throw new Error(`ambiguous session id "${arg}" — matches: ${sample}${matches.length > 5 ? ", ..." : ""}`)
	}
	return openSessionByPath(sessionPathFor(matches[0]))
}

/**
 * Open the most-recent session for cwd if one exists, else create a fresh one.
 * Used at boot.
 *
 * @param {string} cwd
 * @returns {Promise<{ session: Session, id: string, resumed: boolean }>}
 */
export async function openOrCreateSessionForCwd(cwd) {
	const id = await getLatestForCwd(cwd)
	if (id) {
		const { session } = await openSession(id)
		return { session, id, resumed: true }
	}
	const created = await createSession(cwd)
	return { ...created, resumed: false }
}

/** Always create a fresh session, leaving the prior most-recent for `/resume`.
 * @param {string} cwd
 * @returns {Promise<{ session: Session, id: string }>} */
export async function newSessionForCwd(cwd) {
	return createSession(cwd)
}

/** Update the index entry's display name for a session.
 * @param {string} id
 * @param {string} name
 * @returns {Promise<void>} */
export async function setSessionName(id, name) {
	const idx = await readIndex()
	const info = idx.sessions[id]
	if (!info) return
	info.name = name.trim() || undefined
	idx.sessions[id] = info
	await writeIndex(idx)
}

/** Bump updatedAt — call after each successful turn.
 * @param {string} id
 * @returns {Promise<void>} */
export async function touchSession(id) {
	const idx = await readIndex()
	const info = idx.sessions[id]
	if (!info) return
	info.updatedAt = new Date().toISOString()
	idx.sessions[id] = info
	await writeIndex(idx)
}

/**
 * Reconcile the index against on-disk session files. Removes entries whose
 * file no longer exists. Also evicts sessions that contain zero message
 * entries (created via `-r` / `/new` and then abandoned without ever sending
 * a prompt). Useful at boot in case the user deleted a file by hand.
 *
 * @returns {Promise<void>}
 */
export async function reconcileIndex() {
	const idx = await readIndex()
	let changed = false
	for (const [id, info] of Object.entries(idx.sessions)) {
		const path = sessionPathFor(id)
		try {
			await stat(path)
		} catch {
			delete idx.sessions[id]
			for (const [cwd, sid] of Object.entries(idx.cwds)) {
				if (sid === id) delete idx.cwds[cwd]
			}
			changed = true
			void info
			continue
		}
		// File exists — peek inside to see if it has any real message entries.
		// Synthetic project-context messages don't count (they get injected at
		// session creation and would otherwise mask abandoned sessions).
		try {
			const storage = await JsonlSessionStorage.open(path)
			const entries = storage.getEntries()
			const hasMessage = entries.some(
				(/** @type {any} */ e) => e.type === "message" && !isProjectContextMessage(e.message),
			)
			if (!hasMessage) {
				delete idx.sessions[id]
				for (const [cwd, sid] of Object.entries(idx.cwds)) {
					if (sid === id) delete idx.cwds[cwd]
				}
				await rm(path, { force: true })
				changed = true
			}
		} catch {
			// Bad file — leave it for now. Next manual /reload will rebuild from scratch.
		}
	}
	if (changed) await writeIndex(idx)
}

/**
 * Returns true if the session has zero `message`-type entries. Used by
 * chat-mode before swapping sessions: an empty outgoing session can be
 * dropped without warning instead of cluttering the per-cwd index.
 *
 * @param {{ getEntries: () => any[] }} session
 * @returns {boolean}
 */
export function sessionIsEmpty(session) {
	return !session.getEntries().some((/** @type {any} */ e) => {
		if (e.type !== "message") return false
		// The synthetic project-context user message we inject at session
		// creation doesn't count as real activity — a session with nothing
		// but that should still be considered "empty" for auto-clean purposes.
		if (isProjectContextMessage(e.message)) return false
		return true
	})
}

/** Forget a session (used by `/new` or explicit deletion).
 * @param {string} id
 * @returns {Promise<void>} */
export async function deleteSession(id) {
	await rm(sessionPathFor(id), { force: true })
	const idx = await readIndex()
	delete idx.sessions[id]
	for (const [cwd, sid] of Object.entries(idx.cwds)) {
		if (sid === id) delete idx.cwds[cwd]
	}
	await writeIndex(idx)
}

/** Walk the sessions/ dir and rebuild the index from session metadata. Used by /reload.
 * @returns {Promise<void>} */
export async function rebuildIndex() {
	const dir = sessionsDir()
	/** @type {IndexFile} */
	const idx = { cwds: {}, sessions: {} }
	/** @type {string[]} */
	let entries
	try {
		entries = await readdir(dir)
	} catch (/** @type {any} */ err) {
		if (err.code === "ENOENT") return
		throw err
	}
	for (const name of entries) {
		if (!name.endsWith(".jsonl")) continue
		const id = name.replace(/\.jsonl$/, "")
		const path = join(dir, name)
		try {
			const storage = await JsonlSessionStorage.open(path)
			const meta = storage.getMetadata()
			const stats = await stat(path)
			idx.sessions[id] = { cwd: meta.cwd, updatedAt: stats.mtime.toISOString() }
			// Most-recent for cwd: only set if this beats the existing entry.
			const existing = idx.cwds[meta.cwd]
			if (!existing || /** @type {any} */ (idx.sessions[existing]).updatedAt < stats.mtime.toISOString()) {
				idx.cwds[meta.cwd] = id
			}
		} catch {}
	}
	await writeIndex(idx)
	void resolvePath // silence unused-import
}
