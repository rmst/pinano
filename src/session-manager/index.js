import { randomUUID } from "node:crypto"

import { Session } from "./session.js"
import { JsonlSessionStorage } from "./storage-jsonl.js"
import { MemorySessionStorage } from "./storage-memory.js"

export { Session, JsonlSessionStorage, MemorySessionStorage }

/**
 * Open or create a JSONL-backed session.
 * @param {string} filePath
 * @param {{ cwd: string, sessionId?: string, parentSessionPath?: string, createIfMissing?: boolean }} options
 */
export async function openOrCreateJsonlSession(filePath, options) {
	try {
		const storage = await JsonlSessionStorage.open(filePath)
		return new Session(storage)
	} catch (err) {
		if (options.createIfMissing === false) throw err
		const storage = await JsonlSessionStorage.create(filePath, {
			cwd: options.cwd,
			sessionId: options.sessionId ?? randomUUID(),
			parentSessionPath: options.parentSessionPath,
		})
		return new Session(storage)
	}
}

/** Build an in-memory session, primarily for tests. */
export function createMemorySession(options = {}) {
	const metadata = {
		id: options.sessionId ?? randomUUID(),
		createdAt: new Date().toISOString(),
		cwd: options.cwd ?? process.cwd(),
		parentSessionPath: options.parentSessionPath,
	}
	return new Session(new MemorySessionStorage(metadata))
}
