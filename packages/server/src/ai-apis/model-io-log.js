// Optional model wire-log logger and model-adjacent telemetry store.
//
// Full model wire logging is disabled by default. Set service.modelIoLog=true in merged Cerex settings
// to write every model API call to a separate SQLite database.
// Subscription usage snapshots use the same database but are recorded independently. All writes
// are best-effort: failures are swallowed so observability can never break model calls.

import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"

import { configuredModelIoLogDbPath, isModelIoLogConfigured } from "../app/service/config.js"
import { dataRoot } from "../app/paths.js"

export const MODEL_IO_LOG_SCHEMA_VERSION = 3
export const WEBSOCKET_RESPONSE_CREATE_BODY_KIND = "websocket_response_create"
const REDACTED = "[redacted]"
const ATTEMPT_BODY_KINDS = new Set(["inline", "model_request", WEBSOCKET_RESPONSE_CREATE_BODY_KIND])
const DEDUP_ARRAY_PATHS = ["$.input", "$.messages", "$.tools"]
const RESPONSE_EVENT_TYPES = new Set([
	"response.completed",
	"response.done",
	"response.incomplete",
	"response.failed",
	"error",
])

let db
let statements
let warned = false

export function closeModelIoLogDb() {
	try {
		db?.close()
	} catch {}
	db = undefined
	statements = undefined
}

export function isModelIoLogEnabled() {
	try {
		return isModelIoLogConfigured()
	} catch {
		return false
	}
}

export function modelIoLogDbPath() {
	try {
		return configuredModelIoLogDbPath() || join(dataRoot(), "model-io.sqlite")
	} catch {
		return join(process.env.CEREX_HOME || "/tmp/cerex", "data", "model-io.sqlite")
	}
}

function nowIso() {
	return new Date().toISOString()
}

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

function headersToRecord(headers) {
	const out = {}
	if (!headers) return out
	if (headers instanceof Headers) {
		for (const [k, v] of headers.entries()) out[k] = v
		return out
	}
	if (typeof headers.entries === "function") {
		for (const [k, v] of headers.entries()) out[k] = String(v)
		return out
	}
	for (const [k, v] of Object.entries(headers)) out[k] = String(v)
	return out
}

function redactHeaders(headers) {
	const out = {}
	for (const [key, value] of Object.entries(headersToRecord(headers))) {
		out[key] = /^(authorization|proxy-authorization|x-api-key|api-key|openai-api-key|cookie|set-cookie)$/i.test(key)
			? REDACTED
			: value
	}
	return out
}

function safeOptions(options = {}) {
	const out = {}
	for (const key of [
		"temperature",
		"maxTokens",
		"sessionId",
		"toolChoice",
		"reasoningEffort",
		"reasoningSummary",
		"textVerbosity",
		"serviceTier",
		"responseHeaderTimeoutMs",
		"streamInactivityTimeoutMs",
		"firstStreamEventTimeoutMs",
		"streamEventInactivityTimeoutMs",
		"webSocketConnectTimeoutMs",
		"codexTransport",
	]) {
		if (options[key] !== undefined) out[key] = options[key]
	}
	if (options.headers) out.headers = redactHeaders(options.headers)
	return out
}

function warnOnce(err) {
	if (warned || process.env.CEREX_TEST === "1") return
	warned = true
	console.error(`Cerex model I/O database unavailable after error: ${err?.message ?? err}`)
}

function info(message) {
	if (process.env.CEREX_TEST === "1") return
	console.error(message)
}

function createSchema(raw) {
	raw.exec(`
		CREATE TABLE IF NOT EXISTS model_payload_blobs (
			hash TEXT PRIMARY KEY,
			json TEXT NOT NULL
		)
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

function dropSchema(raw) {
	raw.exec("DROP TABLE IF EXISTS model_stream_events")
	raw.exec("DROP TABLE IF EXISTS model_http_attempts")
	raw.exec("DROP TABLE IF EXISTS model_request_payload_parts")
	raw.exec("DROP TABLE IF EXISTS model_requests")
	raw.exec("DROP TABLE IF EXISTS model_payload_blobs")
	raw.exec("DROP TABLE IF EXISTS subscription_usage_snapshots")
}

function migrate(raw) {
	let needsVacuum = false
	raw.exec("BEGIN EXCLUSIVE")
	try {
		let { user_version: version } = raw.prepare("PRAGMA user_version").get()
		version = Number(version ?? 0)
		if (version > MODEL_IO_LOG_SCHEMA_VERSION) throw new Error(`model I/O db schema ${version} is newer than supported ${MODEL_IO_LOG_SCHEMA_VERSION}`)
		if (version < 2) {
			// This is optional wire-log data. The v1 schema stored every SSE event
			// and duplicated full request bodies, so migrating it faithfully would
			// preserve mostly-bloated diagnostics. Start fresh and compact the file.
			dropSchema(raw)
			createSchema(raw)
			raw.exec(`PRAGMA user_version = ${MODEL_IO_LOG_SCHEMA_VERSION}`)
			needsVacuum = version > 0
		} else {
			createSchema(raw)
			if (version < MODEL_IO_LOG_SCHEMA_VERSION) raw.exec(`PRAGMA user_version = ${MODEL_IO_LOG_SCHEMA_VERSION}`)
		}
		raw.exec("COMMIT")
	} catch (err) {
		raw.exec("ROLLBACK")
		throw err
	}
	if (needsVacuum) {
		info("Cerex model I/O log schema changed; discarded old wire-log rows and compacting database")
		try {
			raw.exec("VACUUM")
			raw.exec("PRAGMA wal_checkpoint(TRUNCATE)")
		} catch (err) {
			info(`Cerex model I/O log compaction failed; continuing with fresh schema: ${err?.message ?? err}`)
		}
	}
}

export function initializeModelIoLogDb(path = modelIoLogDbPath()) {
	mkdirSync(dirname(path), { recursive: true })
	const raw = new DatabaseSync(path)
	raw.exec("PRAGMA journal_mode = WAL")
	raw.exec("PRAGMA busy_timeout = 1000")
	raw.exec("PRAGMA foreign_keys = ON")
	migrate(raw)
	return raw
}

function openDb() {
	if (db && statements) return { db, statements }
	const raw = initializeModelIoLogDb()
	db = raw
	statements = {
		db: raw,
		insertBlob: raw.prepare("INSERT OR IGNORE INTO model_payload_blobs (hash, json) VALUES (?, ?)"),
		insertPart: raw.prepare("INSERT INTO model_request_payload_parts (request_id, path, idx, blob_hash) VALUES (?, ?, ?, ?)"),
		insertRequest: raw.prepare(`
			INSERT INTO model_requests (
				id, started_at, status, session_id, run_id, cwd, provider, model, transport, base_url, request_template_json, options_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`),
		finishRequest: raw.prepare(`
			UPDATE model_requests
			SET ended_at = ?, status = ?, final_message_json = ?, error = ?
			WHERE id = ?
		`),
		insertAttempt: raw.prepare(`
			INSERT INTO model_http_attempts (
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
			INSERT INTO subscription_usage_snapshots (
				id, sampled_at, provider, credential_id, account_id, base_url, usage_url, status, payload_json, error
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`),
		getRequest: raw.prepare("SELECT * FROM model_requests WHERE id = ?"),
		listParts: raw.prepare(`
			SELECT p.path, p.idx, b.json
			FROM model_request_payload_parts p
			JOIN model_payload_blobs b ON b.hash = p.blob_hash
			WHERE p.request_id = ?
			ORDER BY p.path ASC, p.idx ASC
		`),
		listAttempts: raw.prepare("SELECT * FROM model_http_attempts WHERE request_id = ? ORDER BY attempt_index ASC"),
	}
	return { db, statements }
}

function withModelIoDb(fn, fallback) {
	try {
		return fn(openDb().statements)
	} catch (err) {
		warnOnce(err)
		return fallback
	}
}

function withLog(fn, fallback) {
	if (!isModelIoLogEnabled()) return fallback
	return withModelIoDb(fn, fallback)
}

function transaction(s, fn) {
	s.db.exec("BEGIN")
	try {
		const result = fn()
		s.db.exec("COMMIT")
		return result
	} catch (err) {
		s.db.exec("ROLLBACK")
		throw err
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

function compactRequestJson(requestJson) {
	const body = tryJsonParse(requestJson)
	if (!body || typeof body !== "object" || Array.isArray(body)) return { templateJson: requestJson, parts: [] }

	const parts = []
	for (const path of DEDUP_ARRAY_PATHS) {
		const key = rootKeyForPath(path)
		if (!key || !Array.isArray(body[key])) continue
		body[key].forEach((item, idx) => {
			const json = safeJson(item)
			parts.push({ path, idx, hash: hashJson(json), json })
		})
		body[key] = []
	}
	return { templateJson: safeJson(body), parts }
}

function reconstructRequest(request, parts) {
	const template = rowJson(request, "request_template_json") ?? request.request_template_json
	if (!template || typeof template !== "object" || Array.isArray(template)) return template

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

function eventTypeForSummary(parsed, data) {
	if (typeof parsed?.type === "string") return parsed.type
	if (data === "[DONE]") return "done"
	const finishReason = parsed?.choices?.find?.((choice) => choice?.finish_reason)?.finish_reason
	if (finishReason) return `chat.${finishReason}`
	return parsed === undefined ? "unknown" : "data"
}

function isFinalProviderEvent(parsed) {
	if (RESPONSE_EVENT_TYPES.has(parsed?.type)) return true
	return !!parsed?.choices?.some?.((choice) => choice?.finish_reason)
}

function updateStreamSummary(attempt, event) {
	const receivedAt = nowIso()
	const parsed = event.parsed ?? tryJsonParse(event.data)
	const eventType = eventTypeForSummary(parsed, event.data)
	const summary = attempt.streamSummary ?? {
		eventCount: 0,
		eventTypes: {},
		startedAt: receivedAt,
		endedAt: null,
		sawDone: false,
		finalEvent: null,
	}
	summary.eventCount++
	summary.eventTypes[eventType] = (summary.eventTypes[eventType] ?? 0) + 1
	summary.endedAt = receivedAt
	if (event.data === "[DONE]") summary.sawDone = true
	else if (isFinalProviderEvent(parsed)) summary.finalEvent = parsed === undefined ? { data: event.data } : parsed
	attempt.streamSummary = summary
}

/**
 * @param {object} params
 * @param {any} params.model
 * @param {string} params.transport
 * @param {string} params.requestJson
 * @param {any} [params.options]
 */
export function beginModelRequest({ model, transport, requestJson, options }) {
	return withLog((s) => {
		const id = randomUUID()
		const sessionId = typeof options?.sessionId === "string" ? options.sessionId : null
		const compact = compactRequestJson(requestJson)
		transaction(s, () => {
			s.insertRequest.run(
				id,
				nowIso(),
				"running",
				sessionId,
				null,
				process.cwd?.() ?? null,
				model?.provider ?? null,
				model?.id ?? null,
				transport,
				model?.baseUrl ?? null,
				compact.templateJson,
				safeJson(safeOptions(options)),
			)
			for (const part of compact.parts) {
				s.insertBlob.run(part.hash, part.json)
				s.insertPart.run(id, part.path, part.idx, part.hash)
			}
		})
		return { id, nextEventSeq: 0, requestJson }
	}, null)
}

export function startHttpAttempt(request, { attemptIndex = 0, method = "POST", url, headers, body, bodyKind: configuredBodyKind }) {
	if (!request?.id) return null
	return withLog((s) => {
		const id = randomUUID()
		const bodyKind = configuredBodyKind ?? (typeof body === "string" && body === request.requestJson ? "model_request" : "inline")
		if (!ATTEMPT_BODY_KINDS.has(bodyKind)) throw new Error(`Unsupported model attempt body kind: ${bodyKind}`)
		s.insertAttempt.run(
			id,
			request.id,
			attemptIndex,
			nowIso(),
			"running",
			method,
			url,
			safeJson(redactHeaders(headers)),
			bodyKind,
			bodyKind === "inline" ? body : null,
		)
		return { id, requestId: request.id, streamSummary: null }
	}, null)
}

export function updateHttpAttemptRequestBody(attempt, { body, bodyKind = "inline" }) {
	if (!attempt?.id) return
	withLog((s) => {
		if (!ATTEMPT_BODY_KINDS.has(bodyKind)) throw new Error(`Unsupported model attempt body kind: ${bodyKind}`)
		s.setAttemptRequestBody.run(bodyKind, bodyKind === "inline" ? body : null, attempt.id)
	}, undefined)
}

export function recordHttpResponse(attempt, response) {
	if (!attempt?.id || !response) return
	withLog((s) => {
		s.setAttemptResponse.run(response.status ?? null, response.statusText ?? null, safeJson(headersToRecord(response.headers)), attempt.id)
	}, undefined)
}

export function finishHttpAttempt(attempt, { status, responseBody = null, error = null } = {}) {
	if (!attempt?.id) return
	withLog((s) => {
		s.finishAttempt.run(
			nowIso(),
			status || "completed",
			responseBody,
			attempt.streamSummary ? safeJson(attempt.streamSummary) : null,
			error,
			attempt.id,
		)
	}, undefined)
}

export function recordStreamEvent(request, attempt, event) {
	if (!request?.id || !attempt?.id) return
	request.nextEventSeq++
	updateStreamSummary(attempt, event)
}

export function finishModelRequest(request, { status, finalMessage = null, error = null } = {}) {
	if (!request?.id) return
	withLog((s) => {
		s.finishRequest.run(nowIso(), status || "completed", finalMessage ? safeJson(finalMessage) : null, error, request.id)
	}, undefined)
}

export function recordSubscriptionUsageSnapshot(snapshot = {}) {
	return withModelIoDb((s) => {
		const id = snapshot.id || randomUUID()
		s.insertSubscriptionUsageSnapshot.run(
			id,
			snapshot.sampledAt || nowIso(),
			snapshot.provider || "openai-codex",
			snapshot.credentialId ?? null,
			snapshot.accountId ?? null,
			snapshot.baseUrl ?? null,
			snapshot.usageUrl ?? null,
			snapshot.status || (snapshot.error ? "error" : "ok"),
			safeJsonOrNull(snapshot.payload),
			snapshot.error ?? null,
		)
		return id
	}, null)
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

export function getModelRequestLog(id) {
	if (!isModelIoLogEnabled() || !id) return null
	return withLog((s) => {
		const request = s.getRequest.get(id)
		if (!request) return null
		const parts = s.listParts.all(id)
		const fullRequest = reconstructRequest(request, parts)
		const attempts = s.listAttempts.all(id).map((attempt) => ({
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
		}))
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
	}, null)
}
