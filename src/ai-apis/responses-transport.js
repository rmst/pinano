// Shared HTTP transport for the OpenAI Responses API. Handles retry/backoff
// for transient failures, dispatches the SSE stream into processResponsesStream,
// and lets callers plug in provider-specific event mapping (e.g. Codex's
// `response.done` → `response.completed` rename) and error parsing (e.g.
// Codex's friendly `usage_limit_reached` message).

import { parseSSE } from "./sse.js"
import { processResponsesStream } from "./codex/responses-shared.js"
import { finishHttpAttempt, recordHttpResponse, recordStreamEvent, startHttpAttempt } from "./model-io-log.js"
import { retryableModelErrorFrom } from "./model-errors.js"

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const DEFAULT_RESPONSE_HEADER_TIMEOUT_MS = 120_000
const DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS = 15 * 60_000

export function isRetryableHttpError(status, errorText = "") {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return true
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused|exceeded request buffer limit while retrying upstream/i.test(errorText)
}

function headersToRecord(headers) {
	const out = {}
	for (const [k, v] of headers.entries()) out[k] = v
	return out
}

export function responseHeaderTimeoutMs(model, override) {
	const value = override ?? model?.responseHeaderTimeoutMs
	if (value === false || value === null) return 0
	const n = Number(value ?? DEFAULT_RESPONSE_HEADER_TIMEOUT_MS)
	return Number.isFinite(n) && n > 0 ? n : 0
}

export function streamInactivityTimeoutMs(model, override) {
	const value = override ?? model?.streamInactivityTimeoutMs
	if (value === false || value === null) return 0
	const n = Number(value ?? DEFAULT_STREAM_INACTIVITY_TIMEOUT_MS)
	return Number.isFinite(n) && n > 0 ? n : 0
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
	if (!timeoutMs) return fetch(url, init)

	const controller = new AbortController()
	let timedOut = false
	let parentAbortCleanup = null
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)

	if (parentSignal) {
		const onAbort = () => controller.abort(parentSignal.reason)
		if (parentSignal.aborted) onAbort()
		else {
			parentSignal.addEventListener("abort", onAbort, { once: true })
			parentAbortCleanup = () => parentSignal.removeEventListener("abort", onAbort)
		}
	}

	try {
		return await fetch(url, { ...init, signal: controller.signal })
	} catch (error) {
		if (timedOut && !parentSignal?.aborted) {
			const timeoutError = new Error(`No response headers received within ${timeoutMs}ms`)
			timeoutError.name = "ResponseHeaderTimeoutError"
			throw timeoutError
		}
		throw error
	} finally {
		clearTimeout(timer)
		parentAbortCleanup?.()
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
	responseHeaderTimeoutMs: responseHeaderTimeoutOverride,
}) {
	let response
	let lastError
	let successAttemptLog = null
	const headerTimeoutMs = responseHeaderTimeoutMs(model, responseHeaderTimeoutOverride)
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new Error("Request was aborted")
		let fetchSucceeded = false
		let attemptFinished = false
		const attemptLog = startHttpAttempt(modelLog, { attemptIndex: attempt, method, url, headers, body: bodyJson })
		try {
			response = await fetchWithResponseHeaderTimeout(url, { method, headers, body: bodyJson, signal }, headerTimeoutMs)
			fetchSucceeded = true
			recordHttpResponse(attemptLog, response)
			if (onResponse) await onResponse({ status: response.status, headers: headersToRecord(response.headers) }, model)
			if (response.ok) {
				successAttemptLog = attemptLog
				break
			}

			const errorText = await response.text().catch(() => "")
			finishHttpAttempt(attemptLog, { status: "http_error", responseBody: errorText })
			attemptFinished = true
			if (attempt < MAX_RETRIES && isRetryableHttpError(response.status, errorText)) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal)
				continue
			}
			const parsed = parseError
				? await parseError(errorText, response.status)
				: { message: errorText || `HTTP ${response.status}` }
			throw new Error(parsed.friendly || parsed.message || `HTTP ${response.status}`)
		} catch (error) {
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
		throw new Error("Response has no body")
	}
	return { response, attemptLog: successAttemptLog }
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
 * @param {(rawText:string, status:number) => Promise<{message:string, friendly?:string}>} [params.parseError]
 * @param {{id:string,nextEventSeq:number} | null} [params.modelLog]
 * @param {string} [params.method]
 * @param {number|false|null} [params.responseHeaderTimeoutMs]
 * @param {number|false|null} [params.streamInactivityTimeoutMs]
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
	responseHeaderTimeoutMs: responseHeaderTimeoutOverride,
	streamInactivityTimeoutMs: streamInactivityTimeoutOverride,
}) {
	const { response, attemptLog: successAttemptLog } = await fetchStreamingResponseWithRetries({
		url,
		method,
		headers,
		bodyJson,
		signal,
		model,
		modelLog,
		onResponse,
		parseError,
		responseHeaderTimeoutMs: responseHeaderTimeoutOverride,
	})
	const inactivityTimeoutMs = streamInactivityTimeoutMs(model, streamInactivityTimeoutOverride)

	try {
		stream.push({ type: "start", partial: output })
		const events = parseSSE(response.body, {
			inactivityTimeoutMs,
			onEvent: (event) => recordStreamEvent(modelLog, successAttemptLog, event),
		})
		await processResponsesStream(mapEvents ? mapEvents(events) : events, output, stream, model)
		finishHttpAttempt(successAttemptLog, { status: "completed" })
	} catch (error) {
		finishHttpAttempt(successAttemptLog, {
			status: signal?.aborted ? "aborted" : "stream_error",
			error: error instanceof Error ? error.message : String(error),
		})
		if (signal?.aborted) throw error
		throw retryableModelErrorFrom(error, { phase: error?.name === "StreamInactivityTimeoutError" ? "stream_inactivity" : "stream" }) ?? error
	}
}
