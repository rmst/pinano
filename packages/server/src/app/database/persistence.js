// Async SQLite adapter for the service persistence contract. Runtime code depends on this semantic API, never on a SQLite connection or SQL statement.

import { fileURLToPath } from "node:url"

import { OrderedWorkerClient } from "../../persistence/worker-client.js"
import { SERVER_RECORD_OPERATIONS } from "../../persistence/server-contract.js"
import { serverDbPath } from "../paths.js"

const WORKER_PATH = fileURLToPath(new URL("./worker.js", import.meta.url))

function operationMeta(operation, args) {
	const first = args[0]
	const sessionId = typeof first === "string" && /Session|Run/.test(operation) ? first : first?.sessionId
	return { database: "server", ...(sessionId ? { sessionId } : {}) }
}

/** Open the SQLite implementation of the async server-persistence contract. */
export async function openServerPersistence(options = {}) {
	const path = options.path ?? serverDbPath()
	const client = new OrderedWorkerClient({
		workerPath: WORKER_PATH,
		label: "ServerPersistence",
		diagnosticTid: 3,
		replayAfterFailure: false,
		warn: (error) => console.error(`Cerex server database unavailable after error: ${error?.message ?? error}`),
	})
	client.setDiagnostics(options.diagnostics)
	const persistence = {
		kind: "sqlite",
		path,
		status() {
			return client.status()
		},
		close() {
			return client.close()
		},
		createSessionStorage(options) {
			return client.request(path, "createSessionStorage", { options }, { database: "server", sessionId: options.sessionId })
		},
		branchSessionStorage(sourceSessionId, options) {
			return client.request(path, "branchSessionStorage", { sourceSessionId, options }, { database: "server", sessionId: options.sessionId })
		},
		openSessionStorage(sessionId) {
			return client.request(path, "openSessionStorage", { sessionId }, { database: "server", sessionId })
		},
		openSessionManifestStorage(sessionId) {
			return client.request(path, "openSessionManifestStorage", { sessionId }, { database: "server", sessionId })
		},
		appendSessionEntry(request) {
			const entry = request.entry
			return client.request(path, "appendSessionEntry", request, {
				database: "server",
				sessionId: request.sessionId,
				entryType: entry?.type,
				messageRole: entry?.type === "message" ? entry.message.role : undefined,
				customType: entry?.type === "custom" ? entry.customType : undefined,
			})
		},
		setSessionLeaf(request) {
			return client.request(path, "setSessionLeaf", request, { database: "server", sessionId: request.sessionId })
		},
		loadTranscriptMessages(sessionId, entryIds) {
			return client.request(path, "loadTranscriptMessages", { sessionId, entryIds }, { database: "server", sessionId })
		},
	}
	for (const operation of SERVER_RECORD_OPERATIONS) {
		persistence[operation] = (...args) => client.request(path, operation, { args }, operationMeta(operation, args))
	}
	try {
		await client.request(path, "ping")
		if (options.recoverRunningRuns) await persistence.interruptRunningRuns()
		return persistence
	} catch (error) {
		try {
			await client.close()
		} catch {
			// Preserve the initialization error; close is best-effort after a worker failure.
		}
		throw error
	}
}
