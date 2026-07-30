// Shared HTTP transport for the OpenAI Responses API. Handles retry/backoff
// for transient failures, dispatches the SSE stream into processResponsesStream,
// and lets callers plug in provider-specific event mapping (e.g. Codex's
// `response.done` → `response.completed` rename) and error parsing (e.g.
// Codex's friendly `usage_limit_reached` message).

import { parseSSE } from "./sse.js"
import { processResponsesStream } from "./codex/responses-shared.js"
import { finishHttpAttempt, recordHttpResponse, recordStreamEvent, startHttpAttempt } from "./model-io-log.js"
import { RetryableModelError, retryableModelErrorFrom } from "./model-errors.js"

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const DEFAULT_RESPONSE_HEADER_TIMEOUT_MS = 120_000
const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 15 * 60_000
const DEFAULT_FIRST_STREAM_EVENT_TIMEOUT_MS = 60_000

function configuredTimeoutMs(value, defaultMs) {
	if (value === false || value === null) return 0
	const n = Number(value ?? defaultMs)
	return Number.isFinite(n) && n > 0 ? n : 0
}

function timeoutOverrideMs(override, modelValue, defaultMs) {
	return override !== undefined ? configuredTimeoutMs(override, defaultMs) : configuredTimeoutMs(modelValue, defaultMs)
}

function firstConfiguredTimeoutMs(values, defaultMs) {
	for (const value of values) {
		if (value !== undefined) return configuredTimeoutMs(value, defaultMs)
	}
	return configuredTimeoutMs(undefined, defaultMs)
}

export function isRetryableHttpError(status, errorText = "") {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return true
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused|exceeded request buffer limit while retrying upstream/i.test(errorText)
}

function httpErrorMessage(parsed, status) {
	const message = parsed?.friendly || parsed?.message
	return typeof message === "string" && message.trim().length > 0 ? message : `HTTP ${status}`
}

async function parseHttpError(parseError, errorText, status) {
	if (!parseError) return { message: errorText || `HTTP ${status}` }
	const parsed = await parseError(errorText, status)
	return parsed && typeof parsed === "object" ? parsed : { message: errorText || `HTTP ${status}` }
}

function isRetryableHttpFailure(status, errorText, parsed) {
	if (parsed?.retryable === true) return true
	if (parsed?.retryable === false) return false
	return isRetryableHttpError(status, errorText)
}

function retryableHttpError(parsed, response, errorText) {
	return new RetryableModelError(httpErrorMessage(parsed, response.status), {
		code: parsed?.code || `http_${response.status}`,
		type: parsed?.type || "http_error",
		phase: "http_response",
		cause: {
			status: response.status,
			statusText: response.statusText,
			body: errorText,
		},
	})
}

function headersToRecord(headers) {
	const out = {}
	for (const [k, v] of headers.entries()) out[k] = v
	return out
}

export function responseHeaderTimeoutMs(model, override) {
	return timeoutOverrideMs(override, model?.responseHeaderTimeoutMs, DEFAULT_RESPONSE_HEADER_TIMEOUT_MS)
}

export function streamInactivityTimeoutMs(model, override) {
	return timeoutOverrideMs(override, model?.streamInactivityTimeoutMs, DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS)
}

export function firstStreamEventTimeoutMs(model, override) {
	return timeoutOverrideMs(override, model?.firstStreamEventTimeoutMs, DEFAULT_FIRST_STREAM_EVENT_TIMEOUT_MS)
}

export function streamEventInactivityTimeoutMs(model, override, streamInactivityOverride) {
	return firstConfiguredTimeoutMs([
		override,
		model?.streamEventInactivityTimeoutMs,
		streamInactivityOverride,
		model?.streamInactivityTimeoutMs,
	], DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS)
}

export function streamFailurePhase(error) {
	if (error?.name === "StreamEventTimeoutError") {
		return error.phase === "stream_start" ? "before_first_event" : "stream_event_inactivity"
	}
	if (error?.name === "StreamInactivityTimeoutError") return "stream_inactivity"
	return "stream"
}

export async function cancelResponseBody(response, reason) {
	try {
		await response?.body?.cancel?.(reason)
	} catch {}
}

export async function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Request was aborted"))
		let t
		const cleanup = () => {
			clearTimeout(t)
			signal?.removeEventListener("abort", onAbort)
		}
		const onAbort = () => {
			cleanup()
			reject(new Error("Request was aborted"))
		}
		t = setTimeout(() => {
			cleanup()
			resolve()
		}, ms)
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}

export async function fetchWithResponseHeaderTimeout(url, init, timeoutMs) {
	const parentSignal = init?.signal
	const controller = new AbortController()
	let timedOut = false
	let parentAbortCleanup = null
	let timer = undefined
	const cleanup = () => {
		if (timer) clearTimeout(timer)
		timer = undefined
		parentAbortCleanup?.()
		parentAbortCleanup = null
	}
	const abort = (reason) => {
		try {
			controller.abort(reason)
		} catch {}
	}

	if (timeoutMs) {
		timer = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, timeoutMs)
	}

	if (parentSignal) {
		const onAbort = () => controller.abort(parentSignal.reason)
		if (parentSignal.aborted) onAbort()
		else {
			parentSignal.addEventListener("abort", onAbort, { once: true })
			parentAbortCleanup = () => parentSignal.removeEventListener("abort", onAbort)
		}
	}

	try {
		const response = await fetch(url, { ...init, signal: controller.signal })
		if (timer) clearTimeout(timer)
		timer = undefined
		return { response, cleanup, abort }
	} catch (error) {
		cleanup()
		if (timedOut && !parentSignal?.aborted) {
			const timeoutError = new Error(`No response headers received within ${timeoutMs}ms`)
			timeoutError.name = "ResponseHeaderTimeoutError"
			throw timeoutError
		}
		throw error
	}
}

export async function fetchStreamingResponseWithRetries({
	url,
	method = "POST",
	headers,
	bodyJson,
	signal,
	model,
	modelLog,
	onResponse,
	parseError,
	attemptIndexOffset = 0,
	responseHeaderTimeoutMs: responseHeaderTimeoutOverride,
}) {
	let response
	let lastError
	let successAttemptLog = null
	let cleanupResponseSignal = () => {}
	let abortResponseSignal = () => {}
	const headerTimeoutMs = responseHeaderTimeoutMs(model, responseHeaderTimeoutOverride)
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new Error("Request was aborted")
		let fetchSucceeded = false
		let attemptFinished = false
		const attemptLog = startHttpAttempt(modelLog, { attemptIndex: attemptIndexOffset + attempt, method, url, headers, body: bodyJson })
		try {
			const fetched = await fetchWithResponseHeaderTimeout(url, { method, headers, body: bodyJson, signal }, headerTimeoutMs)
			response = fetched.response
			cleanupResponseSignal = fetched.cleanup
			abortResponseSignal = fetched.abort
			fetchSucceeded = true
			recordHttpResponse(attemptLog, response)
			if (onResponse) await onResponse({ status: response.status, headers: headersToRecord(response.headers) }, model)
			if (response.ok) {
				successAttemptLog = attemptLog
				break
			}

			const errorText = await response.text().catch(() => "")
			cleanupResponseSignal()
			finishHttpAttempt(attemptLog, { status: "http_error", responseBody: errorText })
			attemptFinished = true
			const parsed = await parseHttpError(parseError, errorText, response.status)
			const retryable = isRetryableHttpFailure(response.status, errorText, parsed)
			if (attempt < MAX_RETRIES && retryable) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal)
				continue
			}
			if (retryable) throw retryableHttpError(parsed, response, errorText)
			throw new Error(httpErrorMessage(parsed, response.status))
		} catch (error) {
			cleanupResponseSignal()
			if (!attemptFinished) {
				finishHttpAttempt(attemptLog, {
					status: error?.name === "AbortError" || error?.message === "Request was aborted" ? "aborted" : "network_error",
					error: error instanceof Error ? error.message : String(error),
				})
				attemptFinished = true
			}
			if (error?.name === "AbortError" || error?.message === "Request was aborted") throw new Error("Request was aborted")
			lastError = error instanceof Error ? error : new Error(String(error))
			if (fetchSucceeded) throw lastError
			if (attempt < MAX_RETRIES) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal)
				continue
			}
			throw lastError
		}
	}

	if (!response?.ok) throw lastError ?? new Error("Failed after retries")
	if (!response.body) {
		finishHttpAttempt(successAttemptLog, { status: "network_error", error: "Response has no body" })
		cleanupResponseSignal()
		throw new Error("Response has no body")
	}
	return { response, attemptLog: successAttemptLog, cleanupResponseSignal, abortResponseSignal }
}

/**
 * POST a Responses-API request with retry/backoff. On success, pushes a
 * `start` event to `stream` and pipes the SSE through processResponsesStream.
 *
 * Retry policy:
 *   - Before response headers: transient network/header-timeout failures retry
 *     inside fetchStreamingResponseWithRetries.
 *   - HTTP responses: retried only when status/body matches isRetryableHttpError.
 *   - After response headers: stream failures are typed as retryable model
 *     failures and left for the runtime's whole-turn continuation path.
 *
 * @param {object}  params
 * @param {string}  params.url
 * @param {Headers|Record<string,string>} params.headers
 * @param {string}  params.bodyJson           pre-serialized JSON body
 * @param {object}  params.output             AssistantMessage being assembled (mutated)
 * @param {object}  params.stream             AssistantMessageEventStream to push events to
 * @param {object}  params.model
 * @param {AbortSignal}                                   [params.signal]
 * @param {(info:{status:number,headers:Record<string,string>}, model:object) => Promise<void>} [params.onResponse]
 * @param {(events: AsyncIterable) => AsyncIterable}      [params.mapEvents]   transform raw SSE events
 * @param {(rawText:string, status:number) => Promise<{message:string, friendly?:string, retryable?:boolean, code?:string, type?:string}>} [params.parseError]
 * @param {{id:string|null,nextEventSeq:number} | null} [params.modelLog]
 * @param {string} [params.method]
 * @param {{serviceTier?: string}} [params.pricingContext]
 * @param {number|false|null} [params.responseHeaderTimeoutMs]
 * @param {number|false|null} [params.streamInactivityTimeoutMs]
 * @param {number|false|null} [params.firstStreamEventTimeoutMs]
 * @param {number|false|null} [params.streamEventInactivityTimeoutMs]
 * @param {number} [params.attemptIndexOffset]
 */
export async function executeResponsesRequest({
	url,
	headers,
	bodyJson,
	output,
	stream,
	model,
	signal,
	onResponse,
	mapEvents,
	parseError,
	modelLog,
	method = "POST",
	pricingContext,
	responseHeaderTimeoutMs: responseHeaderTimeoutOverride,
	streamInactivityTimeoutMs: streamInactivityTimeoutOverride,
	firstStreamEventTimeoutMs: firstStreamEventTimeoutOverride,
	streamEventInactivityTimeoutMs: streamEventInactivityTimeoutOverride,
	attemptIndexOffset = 0,
}) {
	const { response, attemptLog: successAttemptLog, cleanupResponseSignal, abortResponseSignal } = await fetchStreamingResponseWithRetries({
		url,
		method,
		headers,
		bodyJson,
		signal,
		model,
		modelLog,
		onResponse,
		parseError,
		attemptIndexOffset,
		responseHeaderTimeoutMs: responseHeaderTimeoutOverride,
	})
	const inactivityTimeoutMs = streamInactivityTimeoutMs(model, streamInactivityTimeoutOverride)
	const firstEventTimeoutMs = firstStreamEventTimeoutMs(model, firstStreamEventTimeoutOverride)
	const eventInactivityTimeoutMs = streamEventInactivityTimeoutMs(model, streamEventInactivityTimeoutOverride, streamInactivityTimeoutOverride)

	try {
		stream.push({ type: "start", partial: output })
		const events = parseSSE(response.body, {
			inactivityTimeoutMs,
			firstEventTimeoutMs,
			eventInactivityTimeoutMs,
			onEvent: (event) => recordStreamEvent(modelLog, successAttemptLog, event),
		})
		await processResponsesStream(mapEvents ? mapEvents(events) : events, output, stream, model, pricingContext)
		finishHttpAttempt(successAttemptLog, { status: "completed" })
	} catch (error) {
		if (error?.name === "StreamInactivityTimeoutError" || error?.name === "StreamEventTimeoutError") {
			abortResponseSignal(error)
		}
		await cancelResponseBody(response, error)
		finishHttpAttempt(successAttemptLog, {
			status: signal?.aborted ? "aborted" : "stream_error",
			error: error instanceof Error ? error.message : String(error),
		})
		if (signal?.aborted) throw error
		throw retryableModelErrorFrom(error, { phase: streamFailurePhase(error) }) ?? error
	} finally {
		cleanupResponseSignal()
	}
}
