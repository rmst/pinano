// App-level session integration. Owns the on-disk session file plus a
// per-cwd index that tracks the most recently used session for that
// working directory (used by `--auto-resume` and `/resume`).

import { randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, writeFile, stat, rm } from "node:fs/promises"
import { dirname, join, resolve as resolvePath } from "node:path"

import { JsonlSessionStorage, Session } from "../session-manager/index.js"
import { sessionIndexPath, sessionsDir } from "./paths.ts"
import { isProjectContextMessage } from "./project-context.ts"

/** @typedef {import("../session-manager/types.js").SessionEntry} SessionEntry */

interface IndexFile {
	cwds: Record<string, string> // cwd → most recent sessionId
	sessions: Record<string, { cwd: string; updatedAt: string; name?: string }>
}

async function readIndex(): Promise<IndexFile> {
	try {
		return JSON.parse(await readFile(sessionIndexPath(), "utf-8")) as IndexFile
	} catch (err: any) {
		if (err.code === "ENOENT") return { cwds: {}, sessions: {} }
		throw err
	}
}

async function writeIndex(idx: IndexFile): Promise<void> {
	const path = sessionIndexPath()
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, JSON.stringify(idx, null, 2))
}

function sessionPathFor(id: string): string {
	return join(sessionsDir(), `${id}.jsonl`)
}

/** Promote `cwd → sessionId` in the index, refresh updatedAt. */
async function touchIndex(id: string, cwd: string, name?: string): Promise<void> {
	const idx = await readIndex()
	idx.cwds[cwd] = id
	idx.sessions[id] = {
		cwd,
		updatedAt: new Date().toISOString(),
		name: name ?? idx.sessions[id]?.name,
	}
	await writeIndex(idx)
}

export interface SessionListEntry {
	id: string
	cwd: string
	updatedAt: string
	name?: string
	path: string
}

export interface SessionPreviewMessage {
	timestamp: string
	text: string
	role: string
}

export interface SessionPreview {
	first?: SessionPreviewMessage
	lastUser?: SessionPreviewMessage
}

function flattenMessageContent(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return (content as any[])
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join(" ")
}

/**
 * Peek into a session file and pull out the first message + the most recent
 * user message. The synthetic AGENTS.md/CLAUDE.md user message that pinano
 * injects at session creation is filtered out — it isn't useful context for
 * picking a session. Returns an empty object on read failure (corrupt file,
 * missing, etc.) so callers can still render the row.
 */
export async function loadSessionPreview(path: string): Promise<SessionPreview> {
	let storage
	try {
		storage = await JsonlSessionStorage.open(path)
	} catch {
		return {}
	}
	const messages = storage
		.getEntries()
		.filter((e: any) => e.type === "message" && !isProjectContextMessage(e.message))
	const firstEntry = messages[0]
	let lastUserEntry: any
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].message?.role === "user") {
			lastUserEntry = messages[i]
			break
		}
	}
	const preview: SessionPreview = {}
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

/** List sessions, newest first. Optionally filter to a cwd. */
export async function listSessions(filterCwd?: string): Promise<SessionListEntry[]> {
	const idx = await readIndex()
	const out: SessionListEntry[] = []
	for (const [id, info] of Object.entries(idx.sessions)) {
		if (filterCwd && info.cwd !== filterCwd) continue
		out.push({ id, ...info, path: sessionPathFor(id) })
	}
	out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
	return out
}

/** Open the most-recent session for `cwd` if any, else undefined. */
export async function getLatestForCwd(cwd: string): Promise<string | undefined> {
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

export async function createSession(cwd: string): Promise<{ session: Session; id: string }> {
	const id = randomUUID()
	const path = sessionPathFor(id)
	const storage = await JsonlSessionStorage.create(path, { cwd, sessionId: id })
	await touchIndex(id, cwd)
	return { session: new Session(storage), id }
}

export async function openSession(id: string): Promise<{ session: Session; id: string }> {
	const path = sessionPathFor(id)
	const storage = await JsonlSessionStorage.open(path)
	const meta = storage.getMetadata()
	await touchIndex(id, meta.cwd, undefined)
	return { session: new Session(storage), id }
}

export interface ResolvedSession {
	session: Session
	id: string
	cwd: string
	path: string
}

/**
 * Open a session at an arbitrary on-disk path. Used by `--session <path>` to
 * load files that may live outside `sessionsDir()` (e.g. shared from another
 * machine). The session's id and cwd are read from its metadata; if the file
 * is already in `sessionsDir()` the index is touched too.
 */
export async function openSessionByPath(path: string): Promise<ResolvedSession> {
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
 */
export async function resolveSessionArg(arg: string): Promise<ResolvedSession> {
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
 */
export async function openOrCreateSessionForCwd(cwd: string): Promise<{ session: Session; id: string; resumed: boolean }> {
	const id = await getLatestForCwd(cwd)
	if (id) {
		const { session } = await openSession(id)
		return { session, id, resumed: true }
	}
	const created = await createSession(cwd)
	return { ...created, resumed: false }
}

/** Always create a fresh session, leaving the prior most-recent for `/resume`. */
export async function newSessionForCwd(cwd: string): Promise<{ session: Session; id: string }> {
	return createSession(cwd)
}

/** Update the index entry's display name for a session. */
export async function setSessionName(id: string, name: string): Promise<void> {
	const idx = await readIndex()
	const info = idx.sessions[id]
	if (!info) return
	info.name = name.trim() || undefined
	idx.sessions[id] = info
	await writeIndex(idx)
}

/** Bump updatedAt — call after each successful turn. */
export async function touchSession(id: string): Promise<void> {
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
 */
export async function reconcileIndex(): Promise<void> {
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
				(e: any) => e.type === "message" && !isProjectContextMessage(e.message),
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
 */
export function sessionIsEmpty(session: { getEntries: () => any[] }): boolean {
	return !session.getEntries().some((e: any) => {
		if (e.type !== "message") return false
		// The synthetic project-context user message we inject at session
		// creation doesn't count as real activity — a session with nothing
		// but that should still be considered "empty" for auto-clean purposes.
		if (isProjectContextMessage(e.message)) return false
		return true
	})
}

/** Forget a session (used by `/new` or explicit deletion). */
export async function deleteSession(id: string): Promise<void> {
	await rm(sessionPathFor(id), { force: true })
	const idx = await readIndex()
	delete idx.sessions[id]
	for (const [cwd, sid] of Object.entries(idx.cwds)) {
		if (sid === id) delete idx.cwds[cwd]
	}
	await writeIndex(idx)
}

/** Walk the sessions/ dir and rebuild the index from session metadata. Used by /reload. */
export async function rebuildIndex(): Promise<void> {
	const dir = sessionsDir()
	const idx: IndexFile = { cwds: {}, sessions: {} }
	let entries: string[]
	try {
		entries = await readdir(dir)
	} catch (err: any) {
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
			if (!existing || idx.sessions[existing]!.updatedAt < stats.mtime.toISOString()) {
				idx.cwds[meta.cwd] = id
			}
		} catch {}
	}
	await writeIndex(idx)
	void resolvePath // silence unused-import
}
