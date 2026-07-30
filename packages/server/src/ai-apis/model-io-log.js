// Optional model wire-log logger and model-adjacent telemetry store.
//
// Full model wire logging is disabled by default. Set service.modelIoLog=true in merged Cerex settings to retain every model API call in a separate SQLite database. Persistence is ordered through a dedicated worker so request compaction, hashing, SQLite writes, and WAL checkpoints cannot block the service event loop.

import { randomUUID } from "node:crypto"
import { join } from "node:path"

import { configuredModelIoLogDbPath, isModelIoLogConfigured } from "../app/service/config.js"
import { dataRoot } from "../app/paths.js"
import { startOperationSpan } from "../operation-tracing.js"
import {
	closeModelIoLogWorker,
	enqueueModelIoLogWrite,
	flushModelIoLogWorker,
	modelIoLogWorkerStatus,
	requestModelIoLog,
	setModelIoLogWorkerDiagnostics,
} from "./model-io-log-worker-client.js"
import {
	initializeModelIoLogDb as initializeModelIoLogDbAtPath,
	WEBSOCKET_RESPONSE_CREATE_BODY_KIND,
} from "./model-io-log-store.js"
import {
	beginModelPerformance,
	finishModelPerformance,
	recordModelAttemptStarted,
	recordModelResponseHeaders,
	recordModelStreamEvent,
} from "./model-performance.js"

export {
	MODEL_IO_LOG_CHUNK_ITEMS,
	MODEL_IO_LOG_SCHEMA_VERSION,
	WEBSOCKET_RESPONSE_CREATE_BODY_KIND,
} from "./model-io-log-store.js"

const REDACTED = "[redacted]"
const ATTEMPT_BODY_KINDS = new Set(["inline", "model_request", WEBSOCKET_RESPONSE_CREATE_BODY_KIND])
const RESPONSE_EVENT_TYPES = new Set([
	"response.completed",
	"response.done",
	"response.incomplete",
	"response.failed",
	"error",
])

let diagnostics
let warned = false
// Settings are stable for a service lifetime. Resolve them once so model logging never rereads settings files on the request path; closing the worker resets this for tests and explicit environment changes.
let configCache

const REQUEST_TRACE = Symbol("modelRequestTrace")
const ATTEMPT_TRACE = Symbol("modelAttemptTrace")
const REQUEST_PERFORMANCE = Symbol("modelRequestPerformance")
const ATTEMPT_PERFORMANCE = Symbol("modelAttemptPerformance")

/** @param {any} value */
export function setModelIoLogDiagnostics(value) {
	diagnostics = value?.enabled === false ? undefined : value
	setModelIoLogWorkerDiagnostics(value)
}

export async function closeModelIoLogDb() {
	try {
		await closeModelIoLogWorker()
	} finally {
		configCache = undefined
	}
}

export async function flushModelIoLogDb() {
	await flushModelIoLogWorker(modelIoLogDbPath())
}

export function modelIoLogStatus() {
	return modelIoLogWorkerStatus()
}

export function isModelIoLogEnabled() {
	return modelIoLogConfig().enabled
}

export function modelIoLogDbPath() {
	return modelIoLogConfig().path
}

/** Synchronous schema-tooling entry point retained for compatibility. Service runtime code uses the worker-backed API above. */
export function initializeModelIoLogDb(path = modelIoLogDbPath(), trace) {
	return initializeModelIoLogDbAtPath(path, trace)
}

function modelIoLogConfig() {
	if (configCache) return configCache
	try {
		configCache = {
			enabled: isModelIoLogConfigured(),
			path: configuredModelIoLogDbPath() || join(dataRoot(), "model-io.sqlite"),
		}
	} catch {
		configCache = {
			enabled: false,
			path: join(process.env.CEREX_HOME || "/tmp/cerex", "data", "model-io.sqlite"),
		}
	}
	return configCache
}

function nowIso() {
	return new Date().toISOString()
}

function textLength(value) {
	return typeof value === "string" ? value.length : 0
}

function requestTraceArgs({ model, transport, requestJson, options }) {
	return {
		sessionId: typeof options?.sessionId === "string" ? options.sessionId : undefined,
		provider: model?.provider,
		model: model?.id,
		transport,
		requestChars: textLength(requestJson),
	}
}

function firstStreamEventType(event) {
	if (typeof event?.parsed?.type === "string") return event.parsed.type
	if (event?.data === "[DONE]") return "done"
	return "data"
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
		for (const [key, value] of headers.entries()) out[key] = value
		return out
	}
	if (typeof headers.entries === "function") {
		for (const [key, value] of headers.entries()) out[key] = String(value)
		return out
	}
	for (const [key, value] of Object.entries(headers)) out[key] = String(value)
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

function warnOnce(error) {
	if (warned || process.env.CEREX_TEST === "1") return
	warned = true
	console.error(`Cerex model I/O database unavailable after error: ${error?.message ?? error}`)
}

function enqueue(operation, payload, meta) {
	return enqueueModelIoLogWrite(modelIoLogDbPath(), operation, payload, meta)
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
	const traceArgs = requestTraceArgs({ model, transport, requestJson, options })
	const request = { id: null, nextEventSeq: 0, requestJson }
	request[REQUEST_PERFORMANCE] = beginModelPerformance({ model, transport, options })
	if (isModelIoLogEnabled()) {
		const id = randomUUID()
		if (enqueue("beginModelRequest", {
			id,
			startedAt: nowIso(),
			sessionId: traceArgs.sessionId ?? null,
			runId: null,
			cwd: process.cwd?.() ?? null,
			provider: model?.provider ?? null,
			model: model?.id ?? null,
			transport,
			baseUrl: model?.baseUrl ?? null,
			requestJson,
			options: safeOptions(options),
		}, traceArgs)) request.id = id
	}
	if (diagnostics && typeof diagnostics.span === "function") {
		request[REQUEST_TRACE] = {
			args: traceArgs,
			end: startOperationSpan(diagnostics, "ModelRequest.lifecycle", traceArgs),
		}
	}
	return (request.id || request[REQUEST_TRACE] || request[REQUEST_PERFORMANCE]) ? request : null
}

export function startHttpAttempt(request, { attemptIndex = 0, method = "POST", url, headers, body, bodyKind: configuredBodyKind }) {
	const requestTrace = request?.[REQUEST_TRACE]
	const requestPerformance = request?.[REQUEST_PERFORMANCE]
	if (!request?.id && !requestTrace && !requestPerformance) return null
	const bodyKind = configuredBodyKind ?? (typeof body === "string" && body === request.requestJson ? "model_request" : "inline")
	if (!ATTEMPT_BODY_KINDS.has(bodyKind)) {
		warnOnce(new Error(`Unsupported model attempt body kind: ${bodyKind}`))
		return null
	}
	const attemptArgs = {
		...requestTrace?.args,
		attemptIndex,
		method,
		bodyKind,
		requestBodyChars: textLength(body),
	}
	const attemptLog = { id: null, requestId: request?.id ?? null, streamSummary: null }
	if (requestPerformance) {
		recordModelAttemptStarted(requestPerformance)
		attemptLog[ATTEMPT_PERFORMANCE] = requestPerformance
	}
	if (request?.id && isModelIoLogEnabled()) {
		const id = randomUUID()
		if (enqueue("startHttpAttempt", {
			id,
			requestId: request.id,
			attemptIndex,
			startedAt: nowIso(),
			method,
			url,
			headers: redactHeaders(headers),
			bodyKind,
			body,
		}, attemptArgs)) attemptLog.id = id
	}
	if (requestTrace) {
		attemptLog[ATTEMPT_TRACE] = {
			args: attemptArgs,
			headersObserved: false,
			firstEventObserved: false,
			responseStatus: undefined,
			endAttempt: startOperationSpan(diagnostics, "ModelRequest.httpAttempt", attemptArgs),
			endHeaders: startOperationSpan(diagnostics, "ModelRequest.timeToResponseHeaders", attemptArgs),
			endFirstEvent: startOperationSpan(diagnostics, "ModelRequest.timeToFirstStreamEvent", attemptArgs),
		}
	}
	return (attemptLog.id || attemptLog[ATTEMPT_TRACE] || attemptLog[ATTEMPT_PERFORMANCE]) ? attemptLog : null
}

export function updateHttpAttemptRequestBody(attempt, { body, bodyKind = "inline" }) {
	if (!attempt?.id) return
	if (!ATTEMPT_BODY_KINDS.has(bodyKind)) {
		warnOnce(new Error(`Unsupported model attempt body kind: ${bodyKind}`))
		return
	}
	enqueue("updateHttpAttemptRequestBody", { id: attempt.id, bodyKind, body }, {
		...attempt[ATTEMPT_TRACE]?.args,
		bodyKind,
		requestBodyChars: textLength(body),
	})
}

export function recordHttpResponse(attempt, response) {
	if (!attempt || !response) return
	recordModelResponseHeaders(attempt[ATTEMPT_PERFORMANCE])
	const attemptTrace = attempt[ATTEMPT_TRACE]
	if (attemptTrace) {
		attemptTrace.headersObserved = true
		attemptTrace.responseStatus = response.status
		attemptTrace.endHeaders({ responseStatus: response.status, observed: true })
	}
	if (!attempt.id) return
	enqueue("recordHttpResponse", {
		id: attempt.id,
		status: response.status ?? null,
		statusText: response.statusText ?? null,
		headers: headersToRecord(response.headers),
	}, { ...attemptTrace?.args, responseStatus: response.status })
}

export function finishHttpAttempt(attempt, { status, responseBody = null, error = null } = {}) {
	if (!attempt) return
	const outcome = status || "completed"
	const attemptTrace = attempt[ATTEMPT_TRACE]
	if (attemptTrace) {
		const finishArgs = { status: outcome, responseStatus: attemptTrace.responseStatus }
		attemptTrace.endHeaders({ ...finishArgs, observed: attemptTrace.headersObserved })
		attemptTrace.endFirstEvent({ ...finishArgs, observed: attemptTrace.firstEventObserved })
		attemptTrace.endAttempt(finishArgs)
	}
	if (!attempt.id) return
	enqueue("finishHttpAttempt", {
		id: attempt.id,
		endedAt: nowIso(),
		status: outcome,
		responseBody,
		streamSummary: attempt.streamSummary,
		error,
	}, {
		...attemptTrace?.args,
		status: outcome,
		responseStatus: attemptTrace?.responseStatus,
		responseBodyChars: textLength(responseBody),
		streamEventCount: attempt.streamSummary?.eventCount,
	})
}

export function recordStreamEvent(request, attempt, event) {
	if (!request || !attempt) return
	recordModelStreamEvent(request[REQUEST_PERFORMANCE], event)
	const attemptTrace = attempt[ATTEMPT_TRACE]
	if (attemptTrace && !attemptTrace.firstEventObserved) {
		attemptTrace.firstEventObserved = true
		attemptTrace.endFirstEvent({ eventType: firstStreamEventType(event), observed: true })
	}
	if (request.id && attempt.id) {
		request.nextEventSeq++
		updateStreamSummary(attempt, event)
	}
}

export function finishModelRequest(request, { status, finalMessage = null, error = null } = {}) {
	if (!request) return
	const outcome = status || "completed"
	const requestTrace = request[REQUEST_TRACE]
	requestTrace?.end({ status: outcome })
	finishModelPerformance(request[REQUEST_PERFORMANCE], { status: outcome, finalMessage })
	if (!request.id) return
	enqueue("finishModelRequest", {
		id: request.id,
		endedAt: nowIso(),
		status: outcome,
		finalMessage,
		error,
	}, { ...requestTrace?.args, status: outcome })
}

export function recordSubscriptionUsageSnapshot(snapshot = {}) {
	const id = snapshot.id || randomUUID()
	const provider = snapshot.provider || "openai-codex"
	const status = snapshot.status || (snapshot.error ? "error" : "ok")
	const queued = enqueue("recordSubscriptionUsageSnapshot", {
		id,
		sampledAt: snapshot.sampledAt || nowIso(),
		provider,
		credentialId: snapshot.credentialId ?? null,
		accountId: snapshot.accountId ?? null,
		baseUrl: snapshot.baseUrl ?? null,
		usageUrl: snapshot.usageUrl ?? null,
		status,
		payload: snapshot.payload,
		error: snapshot.error ?? null,
	}, { provider, status })
	return queued ? id : null
}

export async function getModelRequestLog(id) {
	if (!isModelIoLogEnabled() || !id) return null
	try {
		return await requestModelIoLog(modelIoLogDbPath(), "getRequestLog", { id })
	} catch (error) {
		warnOnce(error)
		return null
	}
}
