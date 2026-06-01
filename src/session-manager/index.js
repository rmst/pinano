import { randomUUID } from "node:crypto"

import { Session } from "./session.js"
import { MemorySessionStorage } from "./storage-memory.js"
import { SqliteSessionStorage } from "./storage-sqlite.js"

export { Session, MemorySessionStorage, SqliteSessionStorage }
export { contextLoadDisplayFiles, contextLoadDisplayMessage, contextLoadDisplayText, contextLoadPathsFromMessage } from "./context-display.js"

/** Build an in-memory session, primarily for tests. */
export function createMemorySession(options = {}) {
	const metadata = {
		id: options.sessionId ?? randomUUID(),
		createdAt: new Date().toISOString(),
		cwd: options.cwd ?? process.cwd(),
	}
	return new Session(new MemorySessionStorage(metadata))
}
