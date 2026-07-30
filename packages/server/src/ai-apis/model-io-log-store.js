// Synchronous model I/O persistence. This module is used by the dedicated model-log worker; service code must go through model-io-log-worker-client.js so SQLite, hashing, and request compaction never block the service event loop.

import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

export const MODEL_IO_LOG_SCHEMA_VERSION = 4
export const MODEL_IO_LOG_CHUNK_ITEMS = 8
export const WEBSOCKET_RESPONSE_CREATE_BODY_KIND = "websocket_response_create"

const DEDUP_ARRAY_PATHS = ["$.input", "$.messages", "$.tools"]

function safeJson(value) {
	try {
		return JSON.stringify(value)
	} catch (err) {
		return JSON.stringify({ unserializable: true, error: err instanceof Error ? err.message : String(err) })
	}
}

function safeJsonOrNull(value) {
	return value === undefined || value === null ? null : safeJson(value)
}

function tryJsonParse(text) {
	if (typeof text !== "string" || text.length === 0) return undefined
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

function rowJson(row, key) {
	const value = row?.[key]
	if (typeof value !== "string" || value.length === 0) return undefined
	try {
		return JSON.parse(value)
	} catch {
		return value
	}
}

function hashJson(json) {
	return createHash("sha256").update(json).digest("hex")
}

function rootKeyForPath(path) {
	if (!path.startsWith("$.")) return null
	const key = path.slice(2)
	return key.includes(".") ? null : key
}

function createSchema(raw) {
	raw.exec(`
		CREATE TABLE IF NOT EXISTS model_payload_blobs (
			hash TEXT PRIMARY KEY,
			json TEXT NOT NULL
		)
	`)
	raw.exec(`
		CREATE TABLE IF NOT EXISTS model_payload_chunks (
			hash TEXT PRIMARY KEY,
			json TEXT NOT NULL
		) WITHOUT ROWID
	`)
	raw.exec(`
		CREATE TABLE IF NOT EXISTS model_requests (
			id TEXT PRIMARY KEY,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			status TEXT NOT NULL,
			session_id TEXT,
			run_id TEXT,
			cwd TEXT,
			provider TEXT,
			model TEXT,
			transport TEXT,
			base_url TEXT,
			request_template_json TEXT,
			options_json TEXT,
			final_message_json TEXT,
			error TEXT
		)
	`)
	raw.exec(`
		CREATE TABLE IF NOT EXISTS model_request_payload_parts (
			request_id TEXT NOT NULL REFERENCES model_requests(id) ON DELETE CASCADE,
			path TEXT NOT NULL,
			idx INTEGER NOT NULL,
			blob_hash TEXT NOT NULL REFERENCES model_payload_blobs(hash),
			PRIMARY KEY (request_id, path, idx)
		)
	`)
	raw.exec(`
		CREATE TABLE IF NOT EXISTS model_request_payload_chunks (
			request_id TEXT NOT NULL REFERENCES model_requests(id) ON DELETE CASCADE,
			path TEXT NOT NULL,
			chunk_index INTEGER NOT NULL,
			item_count INTEGER NOT NULL,
			chunk_hash TEXT NOT NULL REFERENCES model_payload_chunks(hash),
			PRIMARY KEY (request_id, path, chunk_index)
		) WITHOUT ROWID
	`)
	raw.exec(`
		CREATE TABLE IF NOT EXISTS model_http_attempts (
			id TEXT PRIMARY KEY,
			request_id TEXT NOT NULL REFERENCES model_requests(id) ON DELETE CASCADE,
			attempt_index INTEGER NOT NULL,
			started_at TEXT NOT NULL,
			ended_at TEXT,
			status TEXT NOT NULL,
			method TEXT NOT NULL,
			url TEXT NOT NULL,
			request_headers_json TEXT,
			request_body_kind TEXT NOT NULL DEFAULT 'inline',
			request_body TEXT,
			response_status INTEGER,
			response_status_text TEXT,
			response_headers_json TEXT,
			response_body TEXT,
			stream_summary_json TEXT,
			error TEXT
		)
	`)
	raw.exec(`
		CREATE TABLE IF NOT EXISTS subscription_usage_snapshots (
			id TEXT PRIMARY KEY,
			sampled_at TEXT NOT NULL,
			provider TEXT NOT NULL,
			credential_id TEXT,
			account_id TEXT,
			base_url TEXT,
			usage_url TEXT,
			status TEXT NOT NULL,
			payload_json TEXT,
			error TEXT
		)
	`)
	raw.exec("CREATE INDEX IF NOT EXISTS idx_model_requests_started_at ON model_requests(started_at DESC)")
	raw.exec("CREATE INDEX IF NOT EXISTS idx_model_requests_session ON model_requests(session_id, started_at DESC)")
	raw.exec("CREATE INDEX IF NOT EXISTS idx_model_request_payload_parts_blob ON model_request_payload_parts(blob_hash)")
	raw.exec("CREATE INDEX IF NOT EXISTS idx_model_http_attempts_request ON model_http_attempts(request_id, attempt_index)")
	raw.exec("CREATE INDEX IF NOT EXISTS idx_subscription_usage_snapshots_sampled_at ON subscription_usage_snapshots(sampled_at DESC)")
	raw.exec("CREATE INDEX IF NOT EXISTS idx_subscription_usage_snapshots_provider ON subscription_usage_snapshots(provider, sampled_at DESC)")
}

function dropLegacySchema(raw) {
	raw.exec("DROP TABLE IF EXISTS model_stream_events")
	raw.exec("DROP TABLE IF EXISTS model_http_attempts")
	raw.exec("DROP TABLE IF EXISTS model_request_payload_parts")
	raw.exec("DROP TABLE IF EXISTS model_request_payload_chunks")
	raw.exec("DROP TABLE IF EXISTS model_requests")
	raw.exec("DROP TABLE IF EXISTS model_payload_chunks")
	raw.exec("DROP TABLE IF EXISTS model_payload_blobs")
	raw.exec("DROP TABLE IF EXISTS subscription_usage_snapshots")
}

function migrate(raw) {
	let needsLegacyVacuum = false
	raw.exec("BEGIN EXCLUSIVE")
	try {
		let { user_version: version } = raw.prepare("PRAGMA user_version").get()
		version = Number(version ?? 0)
		if (version > MODEL_IO_LOG_SCHEMA_VERSION) throw new Error(`model I/O db schema ${version} is newer than supported ${MODEL_IO_LOG_SCHEMA_VERSION}`)
		if (version < 2) {
			// The historical v1 logger wrote every stream event and duplicated full bodies. Existing installations migrated away from it in v2; retain that established one-time migration for any stale databases encountered now.
			dropLegacySchema(raw)
			createSchema(raw)
			needsLegacyVacuum = version > 0
		} else {
			// v2 and later migrations are additive. In particular, v4 leaves all item-level payload rows readable and starts writing new requests as fixed-size chunks.
			createSchema(raw)
		}
		raw.exec(`PRAGMA user_version = ${MODEL_IO_LOG_SCHEMA_VERSION}`)
		raw.exec("COMMIT")
	} catch (err) {
		raw.exec("ROLLBACK")
		throw err
	}
	if (needsLegacyVacuum) {
		raw.exec("VACUUM")
		raw.exec("PRAGMA wal_checkpoint(TRUNCATE)")
	}
}

/**
 * Open and migrate a model I/O database synchronously. Service runtime code must not call this directly; it is exported for schema tooling and worker-local use.
 * @param {string} path
 * @param {(stage: string, task: () => any) => any} [trace]
 */
export function initializeModelIoLogDb(path, trace = (_stage, task) => task()) {
	trace("mkdir", () => mkdirSync(dirname(path), { recursive: true }))
	const raw = trace("connect", () => new DatabaseSync(path))
	trace("configure", () => {
		raw.exec("PRAGMA journal_mode = WAL")
		raw.exec("PRAGMA busy_timeout = 1000")
		raw.exec("PRAGMA foreign_keys = ON")
	})
	trace("migrate", () => migrate(raw))
	return raw
}

function compactRequestJson(requestJson) {
	const body = tryJsonParse(requestJson)
	if (!body || typeof body !== "object" || Array.isArray(body)) return { templateJson: requestJson, chunks: [], itemCount: 0 }

	const chunks = []
	let itemCount = 0
	for (const path of DEDUP_ARRAY_PATHS) {
		const key = rootKeyForPath(path)
		if (!key || !Array.isArray(body[key])) continue
		itemCount += body[key].length
		for (let offset = 0; offset < body[key].length; offset += MODEL_IO_LOG_CHUNK_ITEMS) {
			const items = body[key].slice(offset, offset + MODEL_IO_LOG_CHUNK_ITEMS)
			const json = safeJson(items)
			chunks.push({ path, chunkIndex: offset / MODEL_IO_LOG_CHUNK_ITEMS, itemCount: items.length, hash: hashJson(json), json })
		}
		body[key] = []
	}
	return { templateJson: safeJson(body), chunks, itemCount }
}

function reconstructRequest(request, chunks, parts) {
	const template = rowJson(request, "request_template_json") ?? request.request_template_json
	if (!template || typeof template !== "object" || Array.isArray(template)) return template

	if (chunks.length > 0) {
		for (const path of DEDUP_ARRAY_PATHS) {
			const key = rootKeyForPath(path)
			if (!key) continue
			const values = []
			for (const chunk of chunks.filter((entry) => entry.path === path).sort((a, b) => a.chunk_index - b.chunk_index)) {
				const parsed = tryJsonParse(chunk.json)
				if (Array.isArray(parsed)) values.push(...parsed)
			}
			if (values.length > 0) template[key] = values
		}
		return template
	}

	for (const path of DEDUP_ARRAY_PATHS) {
		const key = rootKeyForPath(path)
		if (!key) continue
		const values = parts
			.filter((part) => part.path === path)
			.sort((a, b) => a.idx - b.idx)
			.map((part) => tryJsonParse(part.json) ?? part.json)
		if (values.length > 0) template[key] = values
	}
	return template
}

function prepareStatements(raw, trace) {
	return trace("prepare", () => ({
		db: raw,
		insertPayloadChunk: raw.prepare("INSERT OR IGNORE INTO model_payload_chunks (hash, json) VALUES (?, ?)"),
		insertChunkReference: raw.prepare("INSERT OR IGNORE INTO model_request_payload_chunks (request_id, path, chunk_index, item_count, chunk_hash) VALUES (?, ?, ?, ?, ?)"),
		insertRequest: raw.prepare(`
			INSERT OR IGNORE INTO model_requests (
				id, started_at, status, session_id, run_id, cwd, provider, model, transport, base_url, request_template_json, options_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`),
		finishRequest: raw.prepare(`
			UPDATE model_requests
			SET ended_at = ?, status = ?, final_message_json = ?, error = ?
			WHERE id = ?
		`),
		insertAttempt: raw.prepare(`
			INSERT OR IGNORE INTO model_http_attempts (
				id, request_id, attempt_index, started_at, status, method, url, request_headers_json, request_body_kind, request_body
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`),
		setAttemptRequestBody: raw.prepare(`
			UPDATE model_http_attempts
			SET request_body_kind = ?, request_body = ?
			WHERE id = ?
		`),
		setAttemptResponse: raw.prepare(`
			UPDATE model_http_attempts
			SET response_status = ?, response_status_text = ?, response_headers_json = ?
			WHERE id = ?
		`),
		finishAttempt: raw.prepare(`
			UPDATE model_http_attempts
			SET ended_at = ?, status = ?, response_body = COALESCE(?, response_body), stream_summary_json = COALESCE(?, stream_summary_json), error = ?
			WHERE id = ?
		`),
		insertSubscriptionUsageSnapshot: raw.prepare(`
			INSERT OR IGNORE INTO subscription_usage_snapshots (
				id, sampled_at, provider, credential_id, account_id, base_url, usage_url, status, payload_json, error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`),
		getRequest: raw.prepare("SELECT * FROM model_requests WHERE id = ?"),
		listChunks: raw.prepare(`
			SELECT c.path, c.chunk_index, c.item_count, b.json
			FROM model_request_payload_chunks c
			JOIN model_payload_chunks b ON b.hash = c.chunk_hash
			WHERE c.request_id = ?
			ORDER BY c.path ASC, c.chunk_index ASC
		`),
		listParts: raw.prepare(`
			SELECT p.path, p.idx, b.json
			FROM model_request_payload_parts p
			JOIN model_payload_blobs b ON b.hash = p.blob_hash
			WHERE p.request_id = ?
			ORDER BY p.path ASC, p.idx ASC
		`),
		listAttempts: raw.prepare("SELECT * FROM model_http_attempts WHERE request_id = ? ORDER BY attempt_index ASC"),
	}))
}

function transaction(s, trace, task) {
	trace("begin", () => s.db.exec("BEGIN"))
	try {
		const result = task()
		trace("commit", () => s.db.exec("COMMIT"))
		return result
	} catch (err) {
		trace("rollback", () => s.db.exec("ROLLBACK"))
		throw err
	}
}

function beginModelRequest(s, payload, trace) {
	const compact = trace("compact", () => compactRequestJson(payload.requestJson))
	transaction(s, trace, () => {
		trace("insertRequest", () => s.insertRequest.run(
			payload.id,
			payload.startedAt,
			"running",
			payload.sessionId ?? null,
			payload.runId ?? null,
			payload.cwd ?? null,
			payload.provider ?? null,
			payload.model ?? null,
			payload.transport ?? null,
			payload.baseUrl ?? null,
			compact.templateJson,
			safeJson(payload.options ?? {}),
		))
		trace("insertPayloadChunks", () => {
			for (const chunk of compact.chunks) {
				s.insertPayloadChunk.run(chunk.hash, chunk.json)
				s.insertChunkReference.run(payload.id, chunk.path, chunk.chunkIndex, chunk.itemCount, chunk.hash)
			}
		})
	})
	return {
		payloadChunkCount: compact.chunks.length,
		payloadItemCount: compact.itemCount,
		payloadChars: compact.chunks.reduce((sum, chunk) => sum + chunk.json.length, 0),
		templateChars: compact.templateJson?.length ?? 0,
	}
}

function writeOperation(s, operation, payload, trace) {
	switch (operation) {
		case "beginModelRequest":
			return beginModelRequest(s, payload, trace)
		case "startHttpAttempt":
			return transaction(s, trace, () => trace("write", () => s.insertAttempt.run(
				payload.id,
				payload.requestId,
				payload.attemptIndex,
				payload.startedAt,
				"running",
				payload.method,
				payload.url,
				safeJson(payload.headers ?? {}),
				payload.bodyKind,
				payload.bodyKind === "inline" ? payload.body : null,
			)))
		case "updateHttpAttemptRequestBody":
			return transaction(s, trace, () => trace("write", () => s.setAttemptRequestBody.run(
				payload.bodyKind,
				payload.bodyKind === "inline" ? payload.body : null,
				payload.id,
			)))
		case "recordHttpResponse":
			return transaction(s, trace, () => trace("write", () => s.setAttemptResponse.run(
				payload.status ?? null,
				payload.statusText ?? null,
				safeJson(payload.headers ?? {}),
				payload.id,
			)))
		case "finishHttpAttempt":
			return transaction(s, trace, () => trace("write", () => s.finishAttempt.run(
				payload.endedAt,
				payload.status,
				payload.responseBody,
				safeJsonOrNull(payload.streamSummary),
				payload.error,
				payload.id,
			)))
		case "finishModelRequest":
			return transaction(s, trace, () => trace("write", () => s.finishRequest.run(
				payload.endedAt,
				payload.status,
				safeJsonOrNull(payload.finalMessage),
				payload.error,
				payload.id,
			)))
		case "recordSubscriptionUsageSnapshot":
			return transaction(s, trace, () => trace("write", () => s.insertSubscriptionUsageSnapshot.run(
				payload.id,
				payload.sampledAt,
				payload.provider,
				payload.credentialId ?? null,
				payload.accountId ?? null,
				payload.baseUrl ?? null,
				payload.usageUrl ?? null,
				payload.status,
				safeJsonOrNull(payload.payload),
				payload.error ?? null,
			)))
		default:
			throw new Error(`Unsupported model I/O write operation: ${operation}`)
	}
}

function getModelRequestLog(s, id, trace) {
	const request = trace("readRequest", () => s.getRequest.get(id))
	if (!request) return null
	const chunks = trace("readPayloadChunks", () => s.listChunks.all(id))
	const parts = chunks.length > 0 ? [] : trace("readPayloadParts", () => s.listParts.all(id))
	const fullRequest = trace("reconstructRequest", () => reconstructRequest(request, chunks, parts))
	const attemptRows = trace("readAttempts", () => s.listAttempts.all(id))
	const attempts = trace("deserializeAttempts", () => attemptRows.map((attempt) => ({
		id: attempt.id,
		requestId: attempt.request_id,
		attemptIndex: attempt.attempt_index,
		startedAt: attempt.started_at,
		endedAt: attempt.ended_at,
		status: attempt.status,
		method: attempt.method,
		url: attempt.url,
		requestHeaders: rowJson(attempt, "request_headers_json") ?? {},
		requestBodyKind: attempt.request_body_kind,
		requestBody: attempt.request_body_kind === "model_request"
			? fullRequest
			: attempt.request_body_kind === WEBSOCKET_RESPONSE_CREATE_BODY_KIND
				? { type: "response.create", ...fullRequest }
				: (rowJson(attempt, "request_body") ?? attempt.request_body),
		responseStatus: attempt.response_status,
		responseStatusText: attempt.response_status_text,
		responseHeaders: rowJson(attempt, "response_headers_json") ?? {},
		responseBody: rowJson(attempt, "response_body") ?? attempt.response_body,
		streamSummary: rowJson(attempt, "stream_summary_json") ?? null,
		error: attempt.error,
	})))
	return {
		id: request.id,
		startedAt: request.started_at,
		endedAt: request.ended_at,
		status: request.status,
		sessionId: request.session_id,
		runId: request.run_id,
		cwd: request.cwd,
		provider: request.provider,
		model: request.model,
		transport: request.transport,
		baseUrl: request.base_url,
		request: fullRequest,
		options: rowJson(request, "options_json") ?? {},
		finalMessage: rowJson(request, "final_message_json"),
		error: request.error,
		attempts,
		streamEvents: [],
	}
}

/**
 * @param {string} path
 * @param {(operation: string, stage: string, task: () => any) => any} traceOperation
 */
export function createModelIoLogStore(path, traceOperation) {
	const openTrace = (stage, task) => traceOperation("open", stage, task)
	const raw = initializeModelIoLogDb(path, openTrace)
	const statements = prepareStatements(raw, openTrace)
	return {
		write(operation, payload) {
			const trace = (stage, task) => traceOperation(operation, stage, task)
			return writeOperation(statements, operation, payload, trace)
		},
		getRequestLog(id) {
			const trace = (stage, task) => traceOperation("getModelRequestLog", stage, task)
			return getModelRequestLog(statements, id, trace)
		},
		close() {
			raw.close()
		},
	}
}
