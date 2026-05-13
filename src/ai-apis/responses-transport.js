// Shared HTTP transport for the OpenAI Responses API. Handles retry/backoff
// for transient failures, dispatches the SSE stream into processResponsesStream,
// and lets callers plug in provider-specific event mapping (e.g. Codex's
// `response.done` → `response.completed` rename) and error parsing (e.g.
// Codex's friendly `usage_limit_reached` message).

import { parseSSE } from "./sse.js"
import { processResponsesStream } from "./codex/responses-shared.js"

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

function isRetryable(status, errorText = "") {
	if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText)
}

function sleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Request was aborted"))
		const t = setTimeout(resolve, ms)
		signal?.addEventListener("abort", () => {
			clearTimeout(t)
			reject(new Error("Request was aborted"))
		})
	})
}

function headersToRecord(headers) {
	const out = {}
	for (const [k, v] of headers.entries()) out[k] = v
	return out
}

/**
 * POST a Responses-API request with retry/backoff. On success, pushes a
 * `start` event to `stream` and pipes the SSE through processResponsesStream.
 *
 * Retry policy:
 *   - HTTP responses: retried only when status/body matches isRetryable.
 *   - Network/transport errors (fetch threw): retried up to MAX_RETRIES.
 *   - Non-retryable HTTP errors are NOT re-attempted via the catch path —
 *     once we have a response, the retry decision is final.
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
}) {
	let response
	let lastError
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		if (signal?.aborted) throw new Error("Request was aborted")
		let fetchSucceeded = false
		try {
			response = await fetch(url, { method: "POST", headers, body: bodyJson, signal })
			fetchSucceeded = true
			if (onResponse) {
				await onResponse({ status: response.status, headers: headersToRecord(response.headers) }, model)
			}
			if (response.ok) break

			const errorText = await response.text().catch(() => "")
			if (attempt < MAX_RETRIES && isRetryable(response.status, errorText)) {
				await sleep(BASE_DELAY_MS * 2 ** attempt, signal)
				continue
			}
			const parsed = parseError
				? await parseError(errorText, response.status)
				: { message: errorText || `HTTP ${response.status}` }
			throw new Error(parsed.friendly || parsed.message || `HTTP ${response.status}`)
		} catch (error) {
			if (error?.name === "AbortError" || error?.message === "Request was aborted") {
				throw new Error("Request was aborted")
			}
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
	if (!response.body) throw new Error("Response has no body")

	stream.push({ type: "start", partial: output })
	const events = parseSSE(response.body)
	await processResponsesStream(mapEvents ? mapEvents(events) : events, output, stream, model)
}
