// SQLite implementation of the async server-persistence contract. Synchronous database work stays on this thread; attachment files are materialized asynchronously by the service between short reservation and finalization transactions.

import { runPersistenceWorker } from "../../persistence/worker-runtime.js"
import { SERVER_RECORD_OPERATIONS } from "../../persistence/server-contract.js"
import {
	appendSqliteSessionEntry,
	loadTranscriptMessages,
	sessionStorageSnapshot,
	setSqliteSessionLeaf,
	SqliteSessionStorage,
} from "../../session-manager/storage-sqlite.js"
import { openServerDb } from "./index.js"

const recordOperations = new Set(SERVER_RECORD_OPERATIONS)

function closeServerDbResource(resource) {
	const db = resource.db
	try {
		db.close()
	} finally {
		// qn's SQLite compatibility layer uses sqlite3_close_v2(), so the physical connection remains open until prepared-statement wrappers are released. Drop every API closure before acknowledging close to make resource ownership synchronous across runtimes.
		for (const key of Object.keys(db)) delete db[key]
		resource.db = undefined
	}
}

await runPersistenceWorker({
	label: "Server persistence",
	database: "server",
	open(path, trace) {
		const traceRef = { current: trace }
		const diagnostics = {
			enabled: true,
			span: (name, args) => traceRef.current.span(name, args),
		}
		return { db: openServerDb({ path, diagnostics }), diagnostics, traceRef }
	},
	close: closeServerDbResource,
	execute(resource, operation, payload, trace) {
		resource.traceRef.current = trace
		if (operation === "ping") return null
		if (recordOperations.has(operation)) return resource.db[operation](...(payload.args ?? []))

		const raw = resource.db.raw
		if (operation === "createSessionStorage") {
			return sessionStorageSnapshot(SqliteSessionStorage.create(raw, { ...payload.options, diagnostics: resource.diagnostics }))
		}
		if (operation === "branchSessionStorage") {
			return sessionStorageSnapshot(SqliteSessionStorage.branchFrom(raw, payload.sourceSessionId, {
				...payload.options,
				diagnostics: resource.diagnostics,
			}))
		}
		if (operation === "openSessionStorage") {
			return sessionStorageSnapshot(SqliteSessionStorage.open(raw, payload.sessionId, {
				diagnostics: resource.diagnostics,
			}))
		}
		if (operation === "openSessionManifestStorage") {
			return sessionStorageSnapshot(SqliteSessionStorage.openManifest(raw, payload.sessionId, { diagnostics: resource.diagnostics }))
		}
		if (operation === "appendSessionEntry") return appendSqliteSessionEntry(raw, payload, resource.diagnostics)
		if (operation === "setSessionLeaf") return setSqliteSessionLeaf(raw, payload, resource.diagnostics)
		if (operation === "loadTranscriptMessages") return loadTranscriptMessages(raw, payload.sessionId, payload.entryIds)
		throw new Error(`Unsupported server persistence operation: ${operation}`)
	},
})
