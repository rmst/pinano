const RETRYABLE_MODEL_ERROR_PATTERNS = [
	/server_is_overloaded|service_unavailable_error|rate_limit_exceeded|too_many_requests/i,
	/HTTP (?:429|500|502|503|504|529)\b/i,
	/temporar(?:y|ily).*(?:unavailable|overloaded)|servers? (?:are )?currently overloaded/i,
	/overloaded|service.?unavailable|upstream.?connect|connection.?refused/i,
	/codex.*unsupported content type/i,
	/exceeded request buffer limit while retrying upstream/i,
	/response.?header.?timeout|no response headers received/i,
	/stream.?inactivity|no sse data received/i,
	/no (?:first )?sse event received/i,
	/tls: stream read error|\bECONNRESET\b|\bEPIPE\b|\bETIMEDOUT\b/i,
	/socket hang up|socket closed|connection (?:closed|reset|terminated)|stream (?:closed|terminated|disconnected)/i,
	/^\s*(?:Error\s+)?(?:TypeError\s+)?terminated\s*$/i,
	/\bUND_ERR_(?:SOCKET|BODY_TIMEOUT|HEADERS_TIMEOUT|CONNECT_TIMEOUT)\b/i,
]

const RETRYABLE_MODEL_ERROR_CODES = new Set([
	"server_error",
	"server_is_overloaded",
	"service_unavailable_error",
	"rate_limit_exceeded",
	"too_many_requests",
])

export class RetryableModelError extends Error {
	constructor(message, options = {}) {
		super(message)
		this.name = "RetryableModelError"
		this.retryableModelError = true
		this.code = options.code
		this.errorType = options.type
		this.phase = options.phase
		if (options.cause !== undefined) this.cause = options.cause
	}
}

export function isRetryableModelError(error) {
	return Boolean(error && typeof error === "object" && error.retryableModelError === true)
}

function stringValue(value) {
	if (typeof value !== "string") return undefined
	const trimmed = value.trim()
	return trimmed.length > 0 ? trimmed : undefined
}

function modelErrorCode(error) {
	if (!error || typeof error !== "object") return undefined
	return stringValue(/** @type {any} */ (error).code)
}

function modelErrorType(error) {
	if (!error || typeof error !== "object") return undefined
	return stringValue(/** @type {any} */ (error).errorType) ?? stringValue(/** @type {any} */ (error).type)
}

function isRetryableModelErrorCode(value) {
	const code = stringValue(value)?.toLowerCase()
	return code ? RETRYABLE_MODEL_ERROR_CODES.has(code) : false
}

/** @param {unknown} error */
export function modelErrorMessage(error) {
	if (error instanceof Error) return error.message
	if (error && typeof error === "object") return stringValue(/** @type {any} */ (error).message) ?? String(error ?? "")
	return String(error ?? "")
}

/** @param {unknown} error */
export function modelErrorName(error) {
	return error instanceof Error ? error.name : undefined
}

/**
 * Classify transient model failures in one place. The transport layer may throw
 * typed RetryableModelError instances, but persisted sessions only keep strings,
 * so runtime recovery also needs a conservative message-based fallback.
 * @param {unknown} error
 */
export function classifyModelError(error) {
	if (isRetryableModelError(error)) {
		return {
			retryable: true,
			code: error.code,
			type: error.errorType,
			phase: error.phase,
			message: modelErrorMessage(error),
		}
	}
	const name = modelErrorName(error)
	const message = modelErrorMessage(error)
	const code = modelErrorCode(error)
	const type = modelErrorType(error)
	const text = `${name ?? ""} ${message}`
	const phase = name === "ResponseHeaderTimeoutError"
		? "before_headers"
		: name === "StreamEventTimeoutError"
			? (/** @type {any} */ (error)?.phase === "stream_start" ? "before_first_event" : "stream_event_inactivity")
			: name === "StreamInactivityTimeoutError" ? "stream_inactivity" : undefined
	const retryable = isRetryableModelErrorCode(code)
		|| isRetryableModelErrorCode(type)
		|| RETRYABLE_MODEL_ERROR_PATTERNS.some((pattern) => pattern.test(text))
	return {
		retryable,
		code: code ?? name,
		type,
		phase,
		message,
	}
}

/**
 * @param {unknown} error
 * @param {{ phase?: string, messagePrefix?: string }} [options]
 */
export function retryableModelErrorFrom(error, options = {}) {
	if (isRetryableModelError(error)) return error
	const classified = classifyModelError(error)
	if (!classified.retryable) return undefined
	const message = options.messagePrefix
		? `${options.messagePrefix}: ${classified.message}`
		: classified.message
	return new RetryableModelError(message, {
		code: classified.code,
		type: classified.type,
		phase: options.phase ?? classified.phase,
		cause: error,
	})
}

export function retryableModelErrorDetails(error) {
	const classified = classifyModelError(error)
	if (!classified.retryable) return undefined
	return {
		retryable: true,
		code: classified.code,
		type: classified.type,
		phase: classified.phase,
	}
}

export function messageHasRetryableModelError(message) {
	if (message?.errorDetails?.retryable === true) return true
	return classifyModelError(message?.errorMessage ?? "").retryable
}
