const RETRYABLE_MODEL_ERROR_PATTERNS = [
	/server_is_overloaded|service_unavailable_error|rate_limit_exceeded|too_many_requests/i,
	/HTTP (?:429|500|502|503|504|529)\b/i,
	/temporar(?:y|ily).*(?:unavailable|overloaded)|servers? (?:are )?currently overloaded/i,
	/overloaded|service.?unavailable|upstream.?connect|connection.?refused/i,
	/exceeded request buffer limit while retrying upstream/i,
	/response.?header.?timeout|no response headers received/i,
	/stream.?inactivity|no sse data received/i,
	/tls: stream read error|\bECONNRESET\b|\bEPIPE\b|\bETIMEDOUT\b/i,
	/socket hang up|socket closed|connection (?:closed|reset|terminated)|stream (?:closed|terminated|disconnected)/i,
	/\bUND_ERR_(?:SOCKET|BODY_TIMEOUT|HEADERS_TIMEOUT|CONNECT_TIMEOUT)\b/i,
]

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

/** @param {unknown} error */
export function modelErrorMessage(error) {
	if (error instanceof Error) return error.message
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
	const text = `${name ?? ""} ${message}`
	return {
		retryable: RETRYABLE_MODEL_ERROR_PATTERNS.some((pattern) => pattern.test(text)),
		code: name,
		phase: name === "ResponseHeaderTimeoutError"
			? "before_headers"
			: name === "StreamInactivityTimeoutError" ? "stream_inactivity" : undefined,
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
